# PetYard UI Builder: product IDs and custom blocks

Contract extension: `id_only_v1`, still `schema_version: 1`. Source-checked and expanded 2026-10-15; October extensions are in section 18.

This implements the FE revision-2 product IDs/blocks handoff in this checkout. It is not a deployment announcement. The October FE handoff reports dedicated `/ui-layouts/customer_home` integration; it does not approve the extended renderer or remove legacy Home compatibility. No existing layout, database record, environment setting, or legacy route is automatically migrated or removed.

This is the detailed handoff for the FE's revision-2 product IDs/custom blocks requirements. Sections 9–17 include the change inventory, every editable field and new response field, a full eight-block example, the dependent lifecycle requests, product-detail dictionaries, retained state, error recovery, configuration and acceptance evidence. [The original integration guide](UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md) has also been updated in place and includes this detailed material in chapter 28. Existing lifecycle rules remain unchanged except for the explicitly described profile/compatibility behavior.

## Contents

1. [Current release boundary](#1-current-release-boundary)
2. [Capability discovery](#2-capability-discovery)
3. [First draft: ordered flow](#3-first-draft-ordered-flow)
4. [Content identities and product list](#4-content-identities-and-product-list)
5. [Bilingual authored text](#5-bilingual-authored-text)
6. [Composed-section field reference](#6-composed-section-field-reference)
7. [Required batch-product API](#7-required-batch-product-api)
8. [Recovery and acceptance](#8-recovery-and-acceptance)
9. [Change and route inventory](#9-what-changed-what-did-not-and-which-route-to-use)
10. [Field ownership and values to retain](#10-field-ownership-and-the-values-the-fe-must-retain)
11. [Every custom field and its dependencies](#11-every-custom-content-field-and-its-dependencies)
12. [End-to-end requests and retained state](#12-end-to-end-request-sequence-examples-and-retained-state)
13. [Complete batch contract and product DTO](#13-batch-api-every-request-and-response-field)
14. [Offline work, upgrades and uncertain writes](#14-offline-work-upgrades-duplication-and-uncertain-outcomes)
15. [Errors and the next request](#15-errors-edge-cases-and-which-request-comes-next)
16. [Release configuration and verification](#16-release-configuration-verification-and-rollback-boundaries)
17. [Backend source changes and FE acceptance](#17-backend-source-changes-and-fe-acceptance-checklist)
18. [Subcategories and banner carousels](#18-subcategories-and-banner-carousels-october-production-handoff)

## 1. Current release boundary

- New-profile draft saving and token previews are supported.
- New-profile validation reports release readiness, not just whether JSON can be stored.
- New-profile publishing, scheduling, and rollback publication are blocked until the first compatible customer-app version is confirmed and configured.
- Legacy content publication retains its existing flag and behavior.
- Keep `UI_BUILDER_PUBLIC_CUTOVER_ENABLED=false`. The current live app continues using the existing Home format and ordering routes.
- FE must wire both outgoing normalization and incoming hydration. Exporting local JSON does not perform either integration.
- Local custom-section templates stay FE-owned. An inserted section is an independent inline copy. The backend saves/publishes whole `customer_home` layouts, not independent section templates.

There is no additional database, library service, AI provider, upload-slot flow, or arbitrary component engine.

## 2. Capability discovery

Start with `GET /api/v1/admin/ui-builder/catalog`, using the super-admin bearer token.

The catalog retains the legacy schemas and adds:

| Field | Meaning |
| --- | --- |
| `product_reference_formats` | Prepared wire profiles; currently `["id_only_v1"]`. |
| `capabilities.product_id_draft_storage` | The backend accepts new-profile drafts. |
| `capabilities.component_tree_draft_storage` | The backend accepts the approved composed section in drafts. |
| `capabilities.product_id_references` | Release support; false until publication is enabled and a minimum customer version is configured. |
| `capabilities.component_tree` | Same release boundary for the approved block tree. |
| `id_only_min_app_version` | Confirmed minimum renderer version, or null while unknown. |
| `content_profiles` | New-profile item/text/composed-section schemas. Legacy item schemas must not be applied to these product items. |
| `section_types` | Includes repeatable `composed_section`, requiring `id_only_v1`. |
| `block_types` | The eight approved blocks and allowed properties. |
| `block_renderer_tokens` | Renderer unit and spacing/radius token mapping; not writable content props. |
| `block_renderer_defaults` | Documented FE defaults; omitted properties are not inserted into stored JSON. |
| `product_batch` | Exact loader route, method, size/count bounds and rate limit. |

Do not interpret draft-storage support as customer-renderer or publication support. `remote_preview` remains false until the customer preview entry is separately verified. A token-preview API still exists for integration testing.

## 3. First draft: ordered flow

### Step 1: select real catalog products and approved media

Use existing product listing/detail/picker APIs. Retain product `id` values from those responses. These are MongoDB ObjectIds, not section or item UUIDs.

Upload authored images with the existing one-step `POST /api/v1/admin/ui-builder/assets` multipart route. Retain the returned ready public URL. Use the existing `promo` usage for section/block images and `dynamic_item` for authored cards; there is no new upload lifecycle. Existing public catalog images can still be selected without duplicate uploads.

### Step 2: create a blank draft

```http
POST /api/v1/admin/home-layouts/drafts
Authorization: Bearer <super_admin_access_token>
Content-Type: application/json
```

```json
{
  "layout_key": "customer_home",
  "name": "Prepared custom Home",
  "source": { "type": "blank" }
}
```

Retain `data.id`, `data.revision`, and `data.targeting`. `data.id` is the UUID used in the draft path. Do not send new-profile content to this create endpoint; upgrade the draft with PATCH.

### Step 3: save a complete snapshot

```http
PATCH /api/v1/admin/home-layouts/drafts/<data.id>
Authorization: Bearer <super_admin_access_token>
Content-Type: application/json
If-Match: "1"
X-Client-Mutation-Id: <new UUID for this logical save>
```

Send the entire `name`, `targeting`, and `content` each time, not a partial tree patch. The following product ID is illustrative: replace it with a real active product before validation/preview.

```json
{
  "name": "Prepared custom Home",
  "targeting": {
    "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
    "min_app_version": null, "max_app_version": null, "audience": "all", "priority": 0
  },
  "content": {
    "product_reference_format": "id_only_v1",
    "product_ids": ["68cf1234567890abcdef1234"],
    "sections": [{
      "id": "374c9531-c397-4c14-a25b-2482667072d0",
      "section_type": "dynamic_section",
      "position": 0,
      "data": {
        "enabled": true,
        "title": { "en": "Our picks", "ar": "اختياراتنا" },
        "display_type": "slider", "card_style": "product_card",
        "items": [{
          "id": "cc708598-3537-414e-bf4d-3fd08a779d0e",
          "product_id": "68cf1234567890abcdef1234"
        }]
      }
    }],
    "navigation": { "items": [{
      "key": "home", "label_key": "home", "icon_key": "home",
      "destination": "home", "order": 0, "enabled": true
    }] }
  },
  "change_note": "Prepared product-ID format"
}
```

Replace retained content/revision with the acknowledged response. On an uncertain write, retry the exact body, revision and mutation ID. Do not change a pending legacy request body to the new profile while retaining its old mutation ID.

### Step 4: inspect readiness and preview

`POST /api/v1/admin/home-layouts/drafts/<id>/validate` accepts `{}`. A structurally complete draft can still return `valid:false` with `CLIENT_VERSION_UNSUPPORTED`: no compatible customer release has been configured. This is intentional.

Create an authorized preview with `POST /api/v1/admin/home-layouts/drafts/<id>/preview` and `{"revision":2}` using the latest acknowledged revision. It still checks complete content and real catalog/media availability, but does not require release-version configuration or an active global layout. Retain `preview_id`, `token`, `expires_at`, and `preview_url`.

Read `GET /api/v1/home-layout/preview?token=<token>`. It returns an immutable snapshot with the new profile/product list beside public metadata in `data`, not inside `data.content`. Anyone with the token can read it until expiry/revocation. Later draft edits do not change this preview. Existing revoke/expiry behavior is unchanged.

### Step 5: hydrate products in one batch

Read the preview's `data.product_ids` and call the batch API once. Build an ID-to-product map from its response. Resolve each product placement through that map while keeping every placement UUID and order intact.

Four cards and a product button can refer to three unique products. That requires one batch request for three IDs, not five detail requests. An empty manifest needs no product request.

### Step 6: future coordinated release

Do not activate this step now. FE must first confirm the released renderer version and complete read/write adapters plus device testing.

After explicit release approval, set `UI_BUILDER_ID_ONLY_MIN_APP_VERSION` to that confirmed semantic version, using the project's encrypted environment process. An unset, empty or invalid value disables new-profile publication. No guessed version is added to `.env`.

Save a targeted draft with `targeting.min_app_version` at least that version. A compatible global legacy UI Builder fallback must already exist. Use a deliberately higher priority than the overlapping fallback, or non-overlapping targeting, because equal-priority overlaps are rejected. A default `min_app_version:null`, priority-0 example is not a safe release target.

Then validate, publish immediately or schedule using the existing revision/idempotency flow. Scheduling and rollback revalidate client compatibility and current references. Unknown/older app versions receive the compatible fallback. Unconfiguring support also makes public resolution skip new-profile versions without modifying active records.

The dedicated new published route is `GET /api/v1/ui-layouts/customer_home`. `/api/v1/home-layout` switches only after separate coordinated cutover approval. Published requests use the existing `X-App-Version`, platform, locale and audience targeting headers. Do not replace the legacy GET/PATCH routes during preparation.

## 4. Content identities and product list

| Field | Source and use |
| --- | --- |
| `product_reference_format` | Literal `id_only_v1`; required for product-ID items, bilingual values and composed sections. Not a schema-version number. |
| `product_ids` | Complete unique list of explicit product references; maximum 50. Required even when empty. |
| Section `id` | FE-generated UUID, stable during editing/reordering; unique across the layout. |
| Node/item `id` | FE-generated UUID, stable within an instance; unique across nodes and items within its section. |
| Item `product_id` | Actual catalog ObjectId. A product item contains only `id` and `product_id`. |
| Action `value` for `type:product` | Actual catalog ObjectId; contributes to the same product list. |
| Section `name` | Optional admin label in the new profile. Not its customer heading. Legacy publication still requires it. |

IDs are 24 hexadecimal characters. Product references/list entries are canonicalized to lowercase. Duplicate list entries, including case variants, are rejected. Repeated placements remain separate; do not deduplicate the section's items.

The server compares exact sets, then normalizes ordering: sorted section position order; each owner's explicit product ID, then typed action, then its item array; block preorder with child-array order preserved. Images do not contribute product IDs. Include disabled retained sections and items beyond the presentation limit. Do not include category/brand IDs, UUIDs, local metadata, the previous manifest itself, or products fetched dynamically by built-in sections.

Non-product items retain `id`, authored `name`, optional `subtitle`, optional approved `image_url`, and optional existing safe action. A product-card action in this manual shape is rejected: use `product_id` instead. Brand/category actions do not expand into a live product collection. Product buttons/promos/See All keep their authored labels and typed product action.

## 5. Bilingual authored text

Supported custom fields accept strings or an object containing only `en`/`ar` string values. Each language has its own length limit. Required published text must have at least one non-empty value. Drafts may retain empty text. No extra targeting-specific language requirement is introduced; requiring both languages would be a separate agreed rule.

FE resolves a non-empty current language, then English, then Arabic. The backend preserves both languages through all reads/writes/history and never stores only the language of a request. Product text/commerce fields come from the locale-aware product DTO. Legacy content continues accepting its existing strings only. Backend AI translation is not added.

| Field | Maximum characters per language |
| --- | --- |
| Promo/dynamic title | 80 |
| Promo/dynamic subtitle | 180 |
| Promo CTA text / block button label | 30 |
| Manual item name / subtitle | 80 / 100 |
| Block text value | 1000 |
| Image alt text | 120 |

## 6. Composed-section field reference

`section_type:"composed_section"` is repeatable. `data` permits only `enabled` and `root`. Each node permits only `id`, `type`, `props`, and container `children`. A root column and container child arrays are required even in drafts. Only row/column own children. No arbitrary routes, HTML/CSS, scripts, fetch expressions, stack/icon/container blocks, custom fonts, or inline SVG are accepted.

| Block | Accepted properties and rules |
| --- | --- |
| `image` | `image_url` (approved public HTTPS; required for preview/publication), `aspect_ratio` (`16:9`,`4:3`,`1:1`), `fit` (`cover`,`contain`), `border_radius` (spacing token), `alt_text` (localized). |
| `text` | `value` (localized, required for preview/publication), `style` (`title_large`,`title_medium`,`body_medium`,`body_small`), `align` (`start`,`center`,`end`), `max_lines` (integer 1–12), `color` (color token). |
| `button` | `label` (localized, required for preview/publication), `variant` (`primary`,`secondary`), `size` (`medium`,`large`), `action` (existing safe typed action, required for preview/publication). |
| `catalog_list` | `display_type` (`slider`,`grid`), `card_style` (`product_card`,`pill_avatar`,`square_banner`), `columns_per_row` (integer 1–4), `limit` (integer 1–20), `items` (maximum 20; at least one for preview/publication). |
| `row` | `preset` (`two_columns`,`three_columns`), `gap`, `padding`; ordered `children`. |
| `column` | `gap`, `padding`; ordered `children`. |
| `spacer` | `size` (spacing token). |
| `divider` | `color` (color token). |

Spacing/radius tokens: `none=0`, `sm=8`, `md=16`, `lg=24`. Color tokens: `ink`, `maroon`, `muted`, `white`. These are renderer-owned values, not arbitrary dimensions or hex-color replacements for existing legacy section styles.

Image defaults: 16:9, cover, zero radius. Text maximum-lines default: 6. Button defaults: primary/medium. Catalog display-limit default: 10. Row preset: two columns. Container gap: md; padding: zero. Spacer: md. Text preview sizes: 28/22/16/12, titles bold; button padding 12/20; divider height 16. Defaults stay in the renderer; the server never fills omitted authored props or flattens the tree.

The catalog exposes these values in `block_renderer_tokens` and `block_renderer_defaults`. `block_renderer_tokens.unit` is `logical_pixels`; its `spacing` map defines `none`, `sm`, `md`, and `lg`. Text presets are in `block_renderer_defaults.text.styles`; each preset includes `font_size`, and the title presets include `bold:true`. Button padding is in `button.padding_by_size`; divider height is in `divider.height`. These are renderer hints, not additional allowed source props.

Bounds: depth 6 including root; 50 nodes per section; 12 children per container; 20 items per list; 30 sections; 5 navigation items; 50 unique explicit products; content/final published payload 262144 bytes. New-profile publication requires ordered contiguous section positions from zero. Disabled content still undergoes structural/reference checks. The complete FE example is retained as [a test fixture](test/fixtures/uiLayout.idOnly.json); its product IDs/media URLs are illustrative, not ready resources.

## 7. Required batch-product API

```http
POST /api/v1/products/batch?warehouse=<optional real warehouse ObjectId>
Content-Type: application/json
Accept-Language: ar
Authorization: Bearer <optional valid access token>
x-guest-id: <existing guest identity when not authenticated>
```

```json
{ "ids": ["68cf1234567890abcdef1234", "68cf1234567890abcdef1235"] }
```

Successful response: `{"data":{"products":[/* complete existing product-detail objects */],"unavailable_product_ids":[/* requested unavailable IDs */]}}`. Match by each product's `id`, never array index. Returned products follow first-use request order after deduplication.

- `ids` is the only body field. Maximum 50 supplied entries before deduplication, including repeats; normalized unique IDs also cannot exceed 50. Supply the already unique layout list.
- Raw JSON is limited to 2048 bytes, including whitespace/chunked or inflated bodies. Invalid JSON returns 400; excess bytes return 413; a non-JSON content type returns 415. No silent truncation.
- `warehouse` is the only query parameter. There is no invented `X-Warehouse-ID` or product-loader `X-Location-ID` contract. Use the same actual warehouse context as product detail; existing effective-warehouse rerouting applies.
- `Accept-Language` uses existing `ar`/`en` behavior, defaulting to English. A bad bearer token returns 401, not guest success. Authenticated identity takes precedence over `x-guest-id`.
- The complete detail DTO includes images/main image, variant/options, stock, warehouse stock, prices/discounts/promotions, descriptions, ratings, favorites, restock state, and the current media gallery. This does not replace it with a small card DTO. Valid variant products can have null top-level price.
- Customer/guest reads return only active products. Authorized staff retain the existing detail-access rules, including inactive products, all-language fields, and permission-scoped stock revisions. Moderator warehouse restrictions still apply.
- Every unique requested ID is returned exactly once as a product or unavailable ID. Missing/inactive/hidden products do not expose detailed private existence reasons. Partial availability keeps successful results. Complete service/database failures remain errors.
- Empty accepted `ids:[]` returns empty arrays without product queries. FE should skip the call.
- Products, promotion lookup, favorites/restock state and enabled media use shared/set-based paths. The route performs no product/stock/favorites/order writes, no expiry maintenance writes and no internal detail HTTP requests.
- Successful responses are `Cache-Control: private, no-store`; no shared personalized batch cache is added. Client-side reuse must be scoped to identity, language and warehouse. Refresh context-sensitive products when any context changes.
- Primary product and video aggregation queries use a 10000ms server query bound. Existing supporting identity/promotion/warehouse helpers retain their driver behavior; this is not a promised 10-second total HTTP deadline.
- The complete response is limited to 2097152 bytes. A very large catalog DTO can produce 413 even below 50 IDs. No fields/products are truncated. The copied catalog's largest 50 active BSON records passed six English/Arabic and guest/customer/staff checks; the largest response was 1,437,983 bytes. This sample does not guarantee arbitrary future records or deployed load behavior. If future data requires bounded chunking or a lower agreed limit, agree that with FE rather than silently fall back to one detail GET per product.
- Rate limit: 60 calls per IP per 15 minutes; 429 returns `{"status":"fail","message":"Too many product batch requests."}`. Observe standard rate-limit headers.
- Existing product detail/list/write routes stay unchanged. This read-only POST is additive.

Normal product errors retain the project's existing `status`, `error`, `message` envelope; UI Builder errors retain `error.code`, `error.message`, and path-specific `error.details`. Do not apply the UI Builder error parser to the product endpoint.

## 8. Recovery and acceptance

| Outcome | FE action |
| --- | --- |
| Manifest mismatch/duplicate/invalid ID | Rebuild references from the complete content and fix the highlighted fields; do not silently remove placements. |
| Unknown block/prop or exceeded tree bound | Correct the authored section using catalog schemas/limits. |
| Product/asset unavailable during validation | Select an active product or ready public media and save a new revision. |
| `CLIENT_VERSION_UNSUPPORTED` | Continue drafts/previews; wait for the coordinated renderer release configuration. |
| Revision conflict | Retrieve current draft/revision and resolve edits before issuing a new logical mutation. |
| Uncertain save/publish response | Retry exact body/key as in the original guide. |
| Product unavailable after publication | Render a non-purchasable fallback or omit according to FE's agreed renderer policy. Do not invent price/stock/substitute products. |
| Batch 413/429/service failure | Show/retry the appropriate loading failure. Do not treat it as a successful empty catalog. |
| Older/unknown app version | Preserve compatible layout fallback; do not remove it to activate new content. |

Local checks cover the supplied FE fixture, old/new validation, manifest equality and bounds, bilingual/tree round-trips, revision retries, token previews, version-gated publish/history/clone/scheduling/rollback, batch count/partial/empty/variants/context/media/auth/raw-size handling, and legacy HTTP regressions. They use mocked storage, not live acceptance evidence.

The repeatable isolated check below supplies separate real backend evidence. Remaining release gates include the deployed server's configuration and Redis/cache behavior; admin normalize/hydrate adapters; customer one-batch hydration/fallback behavior; Android/iOS rendering; confirmed app versions; and explicit cutover approval. Do not claim these gates passed from local tests or a copied database alone.

### Repeatable isolated backend acceptance

`scripts/testUiLayoutIdOnlyIntegration.js` exercises the new profile against the approved copied MongoDB cluster. It verifies an empty, uniquely named test database before writing, reads copied public catalog data without changing the source, and cleans up only its test database. It never starts the main application server or changes `.env`.

Provide `UI_LAYOUT_TEST_MONGO_URI` through the process environment; never save its credentials in this document. Set `UI_LAYOUT_TEST_MEDIA=true` to opt into one processed 2-pixel image upload and verified provider cleanup. Set `UI_LAYOUT_TEST_REDIS=true` to opt into a real delayed worker using a unique queue prefix. Redis defaults to `redis://127.0.0.1:6379`; `UI_LAYOUT_TEST_REDIS_URL` may specify a local endpoint. For a local WSL private IPv4 endpoint, also set `UI_LAYOUT_TEST_LOCAL_REDIS_HOST` to its exact host and require a password in the Redis URL. The script rejects unconfirmed remote hosts. Prefer an owned temporary password-protected Redis instance; do not change the installed service or use server Redis. Run `node scripts/testUiLayoutIdOnlyIntegration.js` from the project root. The existing encrypted local environment supplies media configuration and the token-signing secret. These test variables are transient process inputs, not additional application `.env` requirements.

The check requests the copied catalog's largest 50 active BSON product documents together, in English and Arabic, for guest, customer, and authorized staff contexts. It also compares a three-product batch with existing single-product detail responses, tests partial unavailability, and verifies the FE fixture's complete tree/languages/manifest through real HTTP and MongoDB lifecycle operations. A deliberately failed audit write proves that an aborted publication leaves history, the draft, and the active version unchanged. The `2.0.0` renderer version used in this isolated process is synthetic test data, not an approved customer release.

Passing this sample does not promise that every future set of 50 arbitrarily large product documents fits the response cap. The API still fails clearly rather than truncating; future catalog growth must be monitored and any chunking or limit changes agreed with FE. Local Redis/worker acceptance is also distinct from verification of the deployed server and physical mobile applications.

The worker check starts both delayed-job processing and the production reconciliation scheduler. It waits for a publication result for the intended draft, not just any completed queue job. This matters because reconciliation jobs and skipped stale/early publication jobs can complete without publishing a version. The final assertions verify the draft's published status and the new-profile public content in MongoDB.

#### Verified backend evidence — 6 October 2026

- All 85 focused UI Builder/product/media regression tests passed, plus 12 neighboring collection/substitution tests.
- Real HTTP and copied-cluster MongoDB checks passed for complete batch/detail parity, partial unavailability, concurrent save/publish retries, immutable preview, compatibility fallback, history, clone, rollback, ETag/304, and transaction-abort safety.
- The largest 50 active copied product documents were returned together in six contexts: English/Arabic × guest/customer/staff. The largest measured response was 1,437,983 bytes, below the 2,097,152-byte limit. This is sample evidence, not a guarantee about arbitrarily large future catalog records.
- A real multipart upload produced a publicly readable WebP. Delayed new-profile publication passed through an owned password-protected local Redis instance and the real BullMQ processor/reconciliation path.
- Test media deletion was verified at its storage provider; the owned temporary database's collections and temporary Redis instance were removed and absence verified. Source and live database records were not changed.

Application Redis caching was disabled during this isolated lifecycle run; it proves worker/queue acceptance, not deployed cache acceptance. The local `2.0.0` test gate does not authorize a real mobile release. No commit, push, deployment, application `.env` change, or public cutover was part of these fixes.

## 9. What changed, what did not, and which route to use

This section is the implementation handoff for the FE file `UI_BUILDER_BACKEND_PRODUCT_IDS_AND_BLOCKS_HANDOFF.md`, revision 2, dated 2026-10-05. It describes this checkout, not the state of Postman or a deployed server.

| Area | Before / legacy profile | New profile / current extension |
| --- | --- | --- |
| Profile discriminator | Omitted. | `content.product_reference_format:"id_only_v1"`. Server schema version remains 1. |
| Product cards | Authored item fields such as name/image/action. | Exactly `id` and `product_id`. Product presentation and commerce come from product detail. |
| Product loading | Existing detail/list routes. | Added read-only `POST /api/v1/products/batch` for one unique manifest. Existing routes remain. |
| Custom section | No approved composed tree in the legacy profile. | Repeatable `composed_section` with eight approved block types and a column root. |
| Authored text | Literal strings. | Strings or preserved `en`/`ar` maps in supported custom fields. |
| Catalog | Legacy section/item definitions. | Adds profile-specific schemas, block schemas, renderer hints, product limits, loader contract and separate storage/release capabilities. |
| Validation | Existing legacy structure/reference rules. | Adds exact manifest equality, tree bounds, bilingual validation and compatible-client publication checks. |
| Lifecycle | Drafts, previews, versions, schedules, rollback. | Same lifecycle and database; snapshots retain the new profile and full content. |
| Public content | Existing flattened `data.sections/navigation`. | Same envelope, with `product_reference_format` and `product_ids` alongside those fields. No `data.content`. |
| Promotion loading | Shared batch helper could recursively query descendants. | Uses the already-loaded parent map in memory; preserves promotion priority without recursive database reads. |

No template-library endpoint, section-only publication, second database, AI translation service, arbitrary widget engine, upload-slot/completion flow, automatic migration, or legacy-route removal was added.

### Route change inventory

Paths in this change table are relative to `/api/v1`: for example GET `/admin/ui-builder/catalog` means GET `/api/v1/admin/ui-builder/catalog`. Request examples elsewhere use full paths. A base URL already containing that prefix must not repeat it.

| Method and path | Change | Input / returned value affected |
| --- | --- | --- |
| GET `/admin/ui-builder/catalog` | Extended | New capability/profile/block/manifest/batch fields. |
| POST/GET `/admin/ui-builder/assets` | Reused, not replaced | Same multipart upload and ready-image library; image blocks reference their exact returned URLs. |
| POST `/admin/home-layouts/drafts` | Same request; extended clone content | Blank creation remains legacy-shaped. Published-source cloning preserves the selected profile. |
| GET `/admin/home-layouts/drafts` | Same route | Draft list entries retain complete content, including new fields. |
| GET/PATCH `/admin/home-layouts/drafts/:draftId` | Extended | Read/write complete new-profile snapshots; original revision/retry rules remain. |
| DELETE `/admin/home-layouts/drafts/:draftId` | Reused | Archives an editable draft; it does not delete template/product data. |
| POST `/admin/home-layouts/drafts/:draftId/validate` | Extended | New-profile structure, manifest, current references and version-readiness findings. |
| POST `/admin/home-layouts/drafts/:draftId/preview` | Extended | Frozen new-profile snapshot; compatible-release gate is not required for this authorized preparation path. |
| GET `/home-layout/preview?token=...` | Extended | Flattened tree/maps/manifest plus original preview metadata and no-store behavior. |
| DELETE `/admin/home-layouts/previews/:previewId` | Reused | Revokes a token snapshot. |
| POST `/admin/home-layouts/drafts/:draftId/publish` | Extended | Same now/schedule modes; compatible new-profile revision required. |
| POST `/admin/home-layouts/drafts/:draftId/cancel-schedule` | Reused | Returns draft to editable status and advances revision; GET it again. |
| GET `/admin/home-layouts/history` | Same route | New-profile immutable versions included without losing content. |
| GET `/admin/home-layouts/versions/:versionId` | Extended content | Complete historical profile/tree/languages/manifest. |
| POST `/admin/home-layouts/versions/:versionId/rollback` | Extended checks | Revalidates the old profile and references; creates a new immutable version. |
| GET `/admin/home-layouts/audit` | Same route | Existing lifecycle events and validation findings. |
| GET `/ui-layouts/customer_home` | Extended | Compatible published profile, with old-client fallback and ETag. |
| GET/PATCH `/home-layout` | Preserved | Legacy ordering remains active; GET only changes after explicit cutover configuration. |
| POST `/products/batch` | Added | `{"ids":[...]}` returns complete details plus unavailable IDs in one HTTP call. |

Inventory: 19 existing builder method/path combinations + 1 new product-batch combination + 2 retained legacy Home combinations = 22 in this integration scope. Product picker/detail APIs are reused dependencies and are not included in that count. This documentation update does not claim the batch request has been synchronized to Postman.

## 10. Field ownership and the values the FE must retain

### 10.1 Do not mix these identities

| Value | Where it comes from | What it means | Save/reuse it for |
| --- | --- | --- | --- |
| `layout_key` | Fixed literal `customer_home`. | Logical supported Home key. | Draft creation; not a generated ID. |
| `layout_id` | Server draft/version/public response. | Parent-layout UUID. | Local association, cache identity and support; not the draft path ID. |
| Draft `id` / `draft_id` | Server create/read/list response. | One server draft UUID. | PATCH, read, validate, preview, publish, cancel and archive paths. |
| `revision` | Latest acknowledged draft response. | Concurrency counter, initially 1. | Quoted PATCH `If-Match`; numeric preview/publish/schedule body. |
| Section `id` | FE UUID generator when adding an instance. | Section identity. | Preserve when editing/reordering; regenerate when duplicating. |
| Node/item `id` | FE UUID generator when adding an instance. | Identity within the section. | Preserve edits/order; regenerate copied node/item identities when duplicating a section. |
| `product_id` / product action `value` | Existing catalog product `id`. | Product ObjectId. | Placement references, manifest and batch request; do not generate it. |
| Brand/category action `value` | Existing corresponding entity API. | Brand/category ObjectId. | That action only; never add it to the product manifest. |
| Asset `id` / `url` | Ready upload/library response. | Image-library UUID / exact public delivery URL. | Editor selection by ID; authored `image_url` uses URL, not asset ID. |
| Mutation UUID | FE before a logical PATCH. | Retry identity for that complete body/base revision. | Pending operation record; exact retries until outcome resolved. |
| Release UUID | FE before publish/schedule/rollback. | `Idempotency-Key` for one operation. | Pending release record; exact retries only. |
| `preview_id` | Create-preview response. | Preview record UUID. | Revoke path. |
| Preview `token` / `preview_url` | Create-preview response. | Secret read capability / relative read path. | Temporary authorized preview session only; never normal layout JSON or shared logs. |
| `version_id` | Publish/history/version/public response. | Immutable version UUID. | Clone source, version GET, rollback; not a draft ID. |
| `version_number` | Server release/history. | Human-readable parent-layout sequence. | History label and history pagination; not `If-Match`. |
| `schema_version` | Server catalog/snapshot. | Renderer contract, currently 1. | Compatibility checks; never increment it because a draft was saved. |
| `checksum` / ETag | Server public/preview content / public header. | Snapshot identity / conditional-read validator. | Context-scoped customer cache; not a PATCH revision. |
| `next_before` | Relevant list response. | Cursor for that endpoint's next page. | Its own `before` query; never move a cursor between endpoint types. |
| `request_id` | Response `meta`, error or `X-Request-Id`. | Diagnostics for one HTTP request. | Support report; never a retry UUID. |

The mutation header is optional in the backend parser, but required by this reliable FE integration procedure. Omitting it removes mutation-response deduplication. Keep access tokens in the app's secure auth store, not ordinary Hive layout records.

### 10.2 Complete editable PATCH fields

| Field | Source / accepted type | Use and next dependency |
| --- | --- | --- |
| `name` | Admin input, required nonblank string, at most 120 characters. | Editor/draft label, not customer heading. Every full PATCH resends it. |
| `change_note` | Admin/editor note, optional string at most 500 characters or null. | Stored draft note; omission replaces it with null. A release has its own required nonblank note. |
| `targeting` | Complete object from server baseline plus conscious admin edits. | Determines publication scope and compatible customers; do not send preview hints here. |
| `content` | Complete normalized editor snapshot. | Replaces stored content in full; omitted sections/properties are not merged back. |
| `content.product_reference_format` | Literal string `id_only_v1`. | Activates new-profile items/maps/tree rules. Required before sending those shapes. |
| `content.product_ids` | FE-collected unique real product ObjectIds, maximum 50. | Exact explicit-reference set; returned canonical list drives one batch call. Required even when empty. |
| `content.sections` | Ordered FE section array, maximum 30. | Layout content; draft may be empty, preview/publication may not. |
| `content.navigation` | Object with fixed `items` array, maximum 5. | Navigation configuration; enabled Home is required for preview/publication. |
| `content.floating_action_button` | Optional stored chatbot preference. | Preserved in admin drafts/versions, omitted publicly and in preview. No effective customer toggle yet. |

Never PATCH `success`, `data`, `meta`, server IDs, revision, publication timestamps, checksum, local template/Hive records, or product DTO fields. Mutation/revision values belong in headers, not extra editable fields.

### 10.3 Targeting fields and customer request sources

| Target field | Values/default/bound | Source and matching request |
| --- | --- | --- |
| `platforms` | Unique array of android/ios/web; maximum 3; default []. | Admin chooses client platform; customer sends `X-App-Platform`. Empty is unrestricted. |
| `locales` | Unique locale strings such as en/ar/en-US; maximum 20; default []. | App language/locale; customer `X-App-Locale`, else language middleware. Exact matching, not automatic en-US→en equivalence. |
| `country_codes` | Unique uppercase two-letter codes; maximum 250; default []. | Agreed app country source; `X-Country-Code`. Do not assume IP inference. |
| `location_ids` | Unique UUID/ObjectId strings; maximum 100; default []. | Shared agreed presentation-location namespace; `X-Location-Id`. Not a geometry/pet/warehouse calculation. |
| `min_app_version` | null or strict three-part version; default null. | First supporting customer build agreed by release owners; `X-App-Version` must be at least this value. Mandatory supporting floor for new-profile release. |
| `max_app_version` | null or strict three-part version not below minimum; default null. | Optional highest eligible app version; same header. |
| `audience` | all/guest/logged_in; default all. | Admin audience selection. Server derives customer audience from valid bearer authentication; no client audience-override header. |
| `priority` | Integer 0..1000; default 0. | Admin/release priority; higher wins among matching scopes. Changing it changes the scope identity, not only its display order. |

Arrays are sorted by the server. All constraints combine; a missing required context does not match a constrained target. A global scope has empty target arrays, no version range and audience all. Priority does not by itself make it non-global. Targeted publication needs a previously published global fallback. Same-priority overlapping different scopes are rejected; exact scope publication replaces that scope only. Other active scopes remain.

New-profile publication additionally requires `targeting.min_app_version >= catalog.id_only_min_app_version`. A valid JSON version is not proof of a released renderer. Older/unknown versions fall back to a compatible legacy UI Builder version. The old Home ordering record and that UI Builder fallback are separate stored objects.

### 10.4 Section, navigation and stored chatbot fields

| Section field | Origin / rules | Meaning |
| --- | --- | --- |
| `id` | FE UUID; unique across layout. | Stable instance identity. |
| `section_type` | Catalog key. | Built-in, admin_promo, dynamic_section, or new-profile composed_section. |
| `key` | Optional FE string, max 80, unique when present. | Editor/business label; not an action destination. |
| `name` | Optional admin string, max 120. | Optional label in new profile; legacy publication requires nonblank name. |
| `position` | FE integer 0..29, unique. | Array display order. Save sorts/renumbers; new-profile publication requires zero-based contiguous positions matching array order. |
| `data` | Editor object for selected type. | Only that type's allowed configuration. No wrapper enabled/children/visibility. |

Built-ins remain banners, services, newArrivals, collections, shopByUserPet, petProfileBanner, recommended, categories, bestSeller and brands. Each may occur once and uses `data:{}` only. Custom types repeat with different section IDs. Remove a built-in from the array to remove it; do not add unsupported toggles or product fetch URLs.

Each navigation item contains `key`, `label_key`, `icon_key`, `destination`, `order`, `enabled`. The first four come from these fixed definitions; `destination=key`. FE supplies unique integer order 0..4 and boolean enabled; save normalizes order. Publication needs Home enabled.

| key/destination | label_key | icon_key |
| --- | --- | --- |
| home | home | home |
| videos | videos | videos |
| favorites | favorites | favorites |
| orders | myOrders | orders |
| profile | profile | profile |

Stored `floating_action_button` permits required boolean `enabled`, optional `key:"chatbot"`, optional `icon_key:"chatbot"`, and optional `action:{"type":"route","destination":"chatbot"}`. This route-shaped action is specific to FAB; ordinary typed actions use `value`, not `destination`. FAB does not contribute product IDs because no product action is supported there.

### 10.5 Every added catalog field and how to consume it

Catalog uses the admin success envelope data/meta.request_id. Its values are server-owned discovery output; do not send them back as content or let an admin edit capability booleans.

| Field | Origin / value | FE use and dependent behavior |
| --- | --- | --- |
| schema_version | Existing server constant 1. | Select supported parser; id_only_v1 did not increment it. |
| product_reference_formats[] | Implemented profile list, currently id_only_v1. | Find prepared wire schema; not proof of enabled release. |
| capabilities.product_id_draft_storage | True for implemented draft parser. | Permit normalized ID-only draft synchronization if FE adapters exist. |
| capabilities.component_tree_draft_storage | True for implemented eight-block parser. | Permit approved composed draft sections, not arbitrary widgets. |
| capabilities.product_id_references / component_tree | Publication enabled AND supporting server minimum configured. | Gate release UI; do not infer deployed customer readiness from a boolean. |
| capabilities.publish_now | Existing literal-true server release flag. | General publish/rollback availability, still subject to profile checks. |
| capabilities.scheduled_publish | Release flag plus configured queue Redis URL. | Offer scheduling only with environment acceptance; does not test actual worker/Redis health. |
| capabilities.remote_preview | Still false. | Customer preview entry is not declared integrated; backend token API is usable for preparation. |
| capabilities.chatbot_fab_draft_storage / chatbot_fab_config | True / false. | Preference editable privately; ineffective public toggle. |
| capabilities.review_workflow | False. | Do not add submit/approve/reject calls. |
| id_only_min_app_version | Confirmed strict version or null. | Compare targeted min version; null means prepared content cannot release. Never guess it. |
| limits.max_sections / max_navigation_items | 30 / 5, including retained disabled records. | Bound complete layout, not just visible elements. |
| limits.max_dynamic_items | 20. | Bound dynamic and catalog_list placements. |
| limits.max_payload_bytes | 262144 UTF-8 bytes. | Content and final published response limits; server remains final authority. |
| limits.max_product_ids | 50. | Same unique manifest bound as loader; count all explicit actions/cards. |
| limits.max_block_depth / max_block_nodes / max_block_children | 6 / 50 / 12. | Root-inclusive depth, nodes per composed section, children per container. |
| content_profiles[].key / schema_version | id_only_v1 / 1. | Select the profile override, not a second server API version. |
| content_profiles[].section_name_required | False. | Do not require a new-profile section name as customer heading. |
| content_profiles[].localized_text_schema | Literal-string or en/ar-map shape. | Shared editor typing; use each field's actual length, not generic max1000 everywhere. |
| content_profiles[].item_schema | Product id/product_id OR safe authored non-product shape. | Normalize product selections; preserve authored manual items. |
| content_profiles[].custom_text_limits | title80, subtitle180, cta_text30, item_name80, item_subtitle100. | Per-language edit bounds for configurable sections/items. Block text/alt limits are in their own schemas. |
| content_profiles[].composed_section | Owned data/root/node JSON-schema definitions. | Build the exact column-root composer; limit/availability validation still happens on server. |
| content_profiles[].section_types | admin_promo/dynamic_section definitions with profile text/item overrides. | Prefer these for new-profile custom forms; legacy root definitions remain compatible. |
| section_types[].key / repeatable / config_schema | Existing built-ins/customs plus composed_section. | Renderer/data definition; config_schema is data only, not wrapper/content. |
| section_types[].requires_content_profile | id_only_v1 on composed_section. | Require discriminator and manifest before saving that type. |
| block_types[].key / config_schema | Eight keys and owned allowed-prop schemas. | config_schema describes node.props, not whole node. |
| block_renderer_tokens.unit / spacing | logical_pixels / none0-sm8-md16-lg24. | Spacing/radius renderer mapping; do not copy into source props. |
| block_renderer_defaults | Renderer fallback and preset values described in 11.3. | Apply only at render time; never rewrite omitted source props. |
| product_batch.method / endpoint | POST /api/v1/products/batch. | One shared manifest request; not an internal GET loop. |
| product_batch.max_ids / max_request_bytes / max_response_bytes | 50 / 2048 / 2097152. | Request and response bounds; no truncation. |
| product_batch.query_timeout_ms | 10000. | Primary query bound, not total HTTP deadline. |
| product_batch.rate_limit.requests / window_seconds | 60 / 900. | Per-IP request rate; handle 429 and standard rate-limit headers. |
| asset_upload | Existing multipart endpoint/part names/usages/MIME/5-MiB input cap. | Upload/select before a completed image reference; no new completion workflow. |
| navigation_destinations[] / actions[] | Existing fixed navigation and supported typed action definitions. | Populate only approved choices; runtime checks restrict URL/screen/entity values further. |

Schema keywords retain their JSON-schema meanings: type describes the JSON type; properties names owned fields; required lists mandatory publish-ready fields; additionalProperties:false prohibits unknown keys; enum/pattern/format constrain values; min/maxLength constrain strings; minimum/maximum integers; min/maxItems arrays; oneOf selects an alternative; $defs/$ref name/reuse local node definitions. Catalog schemas guide editor forms, not a substitute for draft-vs-publish, manifest equality, UUID uniqueness, secure URL/reference availability, targeting overlap or release checks.

## 11. Every custom content field and its dependencies

Literal text and en/ar maps are supported only in the new profile's custom text fields. Maps permit only en/ar string keys; either language may be omitted and incomplete drafts may contain empty text. Required preview/published text needs at least one nonblank value. FE resolves current nonblank language, then English, then Arabic. No extra rule requiring both languages or backend AI translation was added.

### 11.1 Existing configurable sections under the new profile

| admin_promo data field | Source / meaning | Preview/publication condition |
| --- | --- | --- |
| `enabled` | Admin boolean show/hide. | Required; disabled content still validated and returned. |
| `visibility` | all/logged_in/guest from catalog. | Required renderer rule; not backend authorization. |
| `layout` | card/split/full_banner/text_strip. | Required visual choice. |
| `image_url` | Ready asset or exact approved catalog URL. | Required for split/full_banner. |
| `title` | Authored string/map, max 80 per language. | Nonblank required. |
| `subtitle` | Authored string/map, max 180 per language. | Optional. |
| `cta_text` | Authored string/map, max 30 per language. | Optional. If supplied as a truthy value, server requires action; omit an unused empty map. |
| `background_color`, `title_color`, `subtitle_color`, `cta_background`, `cta_color` | Optional authored `#RRGGBB` or `#AARRGGBB`. | Existing section style fields; not the block color-token enum. |
| `action` | Safe typed action from selected catalog destination. | Required with CTA according to the preceding rule. Product action contributes to manifest. |

| dynamic_section data field | Source / meaning | Preview/publication condition |
| --- | --- | --- |
| `enabled` | Admin boolean toggle. | Required. |
| `title` / `subtitle` | Authored string/map; max 80 / 180 per language. | Title required nonblank; subtitle optional. |
| `display_type` | slider/grid. | Required. |
| `card_style` | product_card/pill_avatar/square_banner. | Required. |
| `columns_per_row` | Optional integer 1..4 chosen in editor. | Grid hint; not a product field. |
| `limit` | Optional integer 1..20. | Renderer display count. All retained items still count in manifest/validation. |
| `show_see_all` | Optional boolean. | True requires section-level action. |
| `background_color` | Optional hex color in existing format. | Section styling. |
| `action` | Typed See All destination. | Not inherited by individual cards; product actions contribute to manifest. |
| `items` | FE ordered placements/manual cards; max 20. | May be empty/missing in draft; at least one for preview/publication. |

A new-profile product item has exactly `id` and `product_id`. No name, subtitle, image, price, rating, stock, variant, action or local editor metadata is allowed on that object.

A manual/non-product item permits `id`, `name`, `subtitle`, `image_url`, `action`. FE creates UUID id; name is max 80 per language and required for preview/publication; subtitle is optional max 100 per language; image is optional approved public URL; action is optional brand/category/subcategory/screen/url. An action of type product in this manual shape is rejected: use a product item instead. Mixed product/manual arrays preserve every placement and order.

Ordinary actions contain required `type` and `value`, no extra keys. Type product/category/subcategory/brand uses a real 24-hex catalog ObjectId, checked for current availability at validation/release. Type screen supports only `add_pet_profile`. Type url accepts public HTTPS on petyardstores.com or its subdomains. Value must be nonblank and at most 2048 characters. Do not invent app routes or feed URLs.

### 11.2 Composed section and every block prop

`composed_section.data` contains only `enabled` and `root`. Root is required even in drafts; enabled is a boolean required for preview/publication. Node fields are FE UUID `id`, catalog `type`, object `props`, and `children` for row/column only. Root type must be column. No node position is sent: ordered children arrays define its position.

| Block.prop | Where it comes from / usage | Type / bound / renderer fallback |
| --- | --- | --- |
| image.image_url | Ready image selection; source image. | Approved public HTTPS; required for preview/publication. Omit while unselected in draft, rather than sending local path/null/empty URL. |
| image.aspect_ratio | Editor crop/aspect choice. | 16:9 / 4:3 / 1:1; fallback 16:9. |
| image.fit | Editor image-fit choice. | cover / contain; fallback cover. |
| image.border_radius | Editor spacing token. | none/sm/md/lg; fallback none. |
| image.alt_text | Authored accessible description. | String/map, max 120 per language; optional. |
| text.value | Admin-authored customer text. | String/map, max 1000 per language; nonblank for preview/publication. |
| text.style | Editor typography preset. | title_large/title_medium/body_medium/body_small. No arbitrary font. |
| text.align | Editor alignment. | start/center/end; renderer handles direction. |
| text.max_lines | Editor truncation choice. | Integer 1..12; fallback 6. |
| text.color | Editor color preset. | ink/maroon/muted/white; no raw hex block color. |
| button.label | Authored visible label. | String/map, max 30 per language; nonblank for preview/publication. |
| button.variant | Editor button preset. | primary/secondary; fallback primary. |
| button.size | Editor button size. | medium/large; fallback medium. |
| button.action | Selected safe typed destination. | Required for preview/publication. Product value contributes to manifest; label stays authored. |
| catalog_list.display_type | Editor layout choice. | slider/grid; optional block prop. No unadvertised backend default. |
| catalog_list.card_style | Editor card preset. | product_card/pill_avatar/square_banner; optional block prop. |
| catalog_list.columns_per_row | Editor grid density. | Integer 1..4; optional. |
| catalog_list.limit | Editor visible item count. | Integer 1..20; fallback 10; does not shorten stored items/manifest. |
| catalog_list.items | Selected product IDs/manual cards. | Ordered array, max 20; same item shapes as dynamic_section; at least one for preview/publication. |
| row.preset | Editor column preset. | two_columns/three_columns; fallback two_columns. Responsive stacking is FE-owned. |
| row.gap | Editor spacing token. | none/sm/md/lg; fallback md. |
| row.padding | Editor spacing token. | none/sm/md/lg; fallback none. |
| column.gap | Editor spacing token. | none/sm/md/lg; fallback md. |
| column.padding | Editor spacing token. | none/sm/md/lg; fallback none. |
| spacer.size | Editor vertical spacing token. | none/sm/md/lg; fallback md. |
| divider.color | Editor color preset. | ink/maroon/muted/white; optional. |

Containers require a children array even while drafting. Root children may be empty in a draft, but not for preview/publication. Non-containers must omit children, even an empty array. Nodes and catalog items share one UUID-uniqueness set per section. Repeated product ObjectIds do not violate UUID uniqueness.

Root-inclusive depth <=6, <=50 nodes per composed section, <=12 children per container, <=20 items per catalog. Catalog items are not block nodes, but their identities still must be unique. No container/stack/icon, dimensions, CSS, scripts, SVG, executable expressions, custom fonts or client fetch URLs.

### 11.3 Renderer hints are not source properties

Catalog `block_renderer_tokens.unit` is logical_pixels. Its spacing map is none=0, sm=8, md=16, lg=24, also used by radius. Color token definitions belong to the FE theme; backend accepts names, not an arbitrary color/font registry.

`block_renderer_defaults.text.styles` defines font_size 28/22/16/12 for title_large/title_medium/body_medium/body_small; title presets include bold:true. Button `padding_by_size` is medium=12, large=20. Divider `height` is 16. Other fallback fields are described above.

Do not send font_size, bold, padding_by_size or divider height as authored props. Do not populate omitted props merely because a renderer fallback exists. Backend stores the authored props; FE applies fallback during rendering. For props without a documented fallback, use the existing agreed FE renderer behavior, not a guessed backend rule.

### 11.4 Manifest construction, comparison and reuse

Build the list from the complete normalized outgoing content, after converting local editor product selections to ID-only placements:

1. Keep section array/order and all placements. Include disabled sections.
2. Visit explicit product_id values and supported typed product actions. At each owner, backend visits product ID, then action, then items; block traversal follows child-array preorder.
3. Include product actions in promos, buttons and section-level See All. Include items beyond a presentation limit.
4. Ignore brand/category IDs, node/item/section UUIDs, local metadata, previous manifest and runtime-built-in product queries.
5. Lowercase ObjectIds and deduplicate by first use. The expected unique set must contain at most 50.
6. Supply that exact set as product_ids. Backend rejects missing/extra/duplicate/invalid entries; it does not repair a stale list by discarding content.
7. On successful save, retain the server's canonical content/product_ids/revision. Backend sorts sections by position before computing returned canonical traversal order.
8. For preview/public reads, batch-load the manifest returned by that exact snapshot, not a newer unsaved editor manifest.

Manifest ordering must be acknowledged by FE before activation because its exporter originally scans field insertion order. The exact set is mandatory now; ordering normalization never authorizes moving cards/children.

## 12. End-to-end request sequence, examples and retained state

### 12.1 Start safely: capability and catalog dependencies first

Use the existing verified super-admin login, then GET `/api/v1/admin/ui-builder/catalog`. Retain schemas/limits/profile metadata for this environment; refresh on entry or release changes. Do not keep capability booleans permanently in Hive.

Select real products through existing catalog APIs and retain product id. Select real brands/categories for their own actions. Upload custom artwork through multipart POST `/api/v1/admin/ui-builder/assets` with binary image and text usage=promo or dynamic_item. Let the HTTP library supply the boundary. No draft ID/upload slot/completion is needed.

Upload response data fields: id (asset UUID), status (ready), usage (selection category), url (exact reusable public URL), width/height (decoded input dimensions), byte_size (input bytes), created_at (library creation display timestamp). These are not guaranteed processed-output dimensions/bytes. Store id/url locally; write url into the content. JPEG/PNG/WebP only, input <=5 MiB, <=8000 per dimension, <=25 million pixels; SVG/MIME spoofing fail. Do not send null or local file paths as URLs. Registered catalog media can be reused only by its exact stored URL; transformed DTO URLs may not match. Prefer builder uploads when unsure.

GET assets uses optional limit 1..100 (default 30) and opaque before from data.next_before. Response has items and next_before; null means stop. No asset-delete endpoint exists.

### 12.2 Create blank once, then retain the server baseline

```http
POST /api/v1/admin/home-layouts/drafts
Authorization: Bearer <super-admin-token>
Content-Type: application/json
```

```json
{"layout_key":"customer_home","name":"Custom Home blocks","source":{"type":"blank"}}
```

Representative complete data, enclosed by the normal server meta envelope:

```json
{
  "data": {
    "id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "layout_id": "a7547451-291d-4ffb-95a3-03e0fb4fd764",
    "layout_key": "customer_home",
    "name": "Custom Home blocks",
    "status": "draft",
    "schema_version": 1,
    "revision": 1,
    "based_on_version_id": null,
    "targeting": {
      "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
      "min_app_version": null, "max_app_version": null, "audience": "all", "priority": 0
    },
    "content": {"sections":[],"navigation":{"items":[]}},
    "change_note": null,
    "scheduled_for": null,
    "schedule_failure": null,
    "created_at": "2026-10-06T09:00:00Z",
    "updated_at": "2026-10-06T09:00:00Z"
  },
  "meta": {"request_id":"79f7a4f2-dd10-479f-8ed5-73c9f73e8f52"}
}
```

Save data.id, layout_id, revision and the acknowledged targeting/content. Status controls permitted next actions. based_on_version_id identifies the source version when cloned, else null. created_at/updated_at are server display/audit timestamps, not concurrency locks. scheduled_for/schedule_failure are null until scheduling/failure state applies. Schema version is server-owned.

Create accepts optional change_note <=500. Source is blank or published; published requires version_id from history/publication. Create has no mutation/release idempotency support: uncertain response needs reconciliation with draft list, not blind duplicate creation. Never identify a server draft solely by its non-unique name.

### 12.3 Save the full new-profile example

Prerequisites: a draft in status draft, latest acknowledged revision, complete local normalized content, fresh mutation UUID recorded before sending. Save may contain structurally valid incomplete fields; preview/release requires real available references and completed content.

For the example draft above:

```http
PATCH /api/v1/admin/home-layouts/drafts/8ec682ef-aacd-4639-9d23-b98ea8234dbe
Authorization: Bearer <super-admin-token>
Content-Type: application/json
If-Match: "1"
X-Client-Mutation-Id: 112b5f6c-9a65-49c5-a7e3-9f5374fe06fb
```

Complete editable body, matching the FE's eight-block fixture. ObjectIds/artwork are illustrative; replace every entity ID and image URL consistently before real validation. This is a prepared draft, not a publish request; min_app_version intentionally remains null.

```json
{
  "name": "Custom Home blocks",
  "targeting": {
    "platforms": [
      "android",
      "ios"
    ],
    "locales": [
      "en",
      "ar"
    ],
    "country_codes": [],
    "location_ids": [],
    "min_app_version": null,
    "max_app_version": null,
    "audience": "all",
    "priority": 0
  },
  "content": {
    "product_reference_format": "id_only_v1",
    "product_ids": [
      "68cf1234567890abcdef1234",
      "68cf1234567890abcdef1235",
      "68cf1234567890abcdef1236"
    ],
    "sections": [
      {
        "id": "991c3977-f045-4a93-b07e-7b3b87f8ad31",
        "section_type": "dynamic_section",
        "position": 0,
        "data": {
          "enabled": true,
          "title": {
            "en": "Popular picks",
            "ar": "اختيارات شائعة"
          },
          "display_type": "slider",
          "card_style": "product_card",
          "limit": 10,
          "items": [
            {
              "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe06fb",
              "product_id": "68cf1234567890abcdef1234"
            },
            {
              "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe06fc",
              "product_id": "68cf1234567890abcdef1235"
            }
          ]
        }
      },
      {
        "id": "991c3977-f045-4a93-b07e-7b3b87f8ad32",
        "section_type": "composed_section",
        "position": 1,
        "data": {
          "enabled": true,
          "root": {
            "id": "c8beb25c-83f5-4050-bb56-548fa4e6a402",
            "type": "column",
            "props": {
              "gap": "md",
              "padding": "md"
            },
            "children": [
              {
                "id": "fb97f598-d1d3-4a37-8776-6b1c88f03c66",
                "type": "image",
                "props": {
                  "image_url": "https://media.petyardstores.com/ui-builder/example-banner.webp",
                  "aspect_ratio": "16:9",
                  "fit": "cover",
                  "border_radius": "md",
                  "alt_text": {
                    "en": "Cat essentials",
                    "ar": "مستلزمات القطط"
                  }
                }
              },
              {
                "id": "44f90743-b7a7-4515-af4e-a2e91e40bb09",
                "type": "text",
                "props": {
                  "value": {
                    "en": "Everything for your cat",
                    "ar": "كل ما تحتاجه قطتك"
                  },
                  "style": "title_medium",
                  "align": "start",
                  "max_lines": 3,
                  "color": "ink"
                }
              },
              {
                "id": "4c9884c0-e8ba-42e2-bde2-63c703bce084",
                "type": "row",
                "props": {
                  "preset": "two_columns",
                  "gap": "sm",
                  "padding": "none"
                },
                "children": [
                  {
                    "id": "4c9884c0-e8ba-42e2-bde2-63c703bce085",
                    "type": "catalog_list",
                    "props": {
                      "display_type": "grid",
                      "card_style": "product_card",
                      "columns_per_row": 2,
                      "limit": 10,
                      "items": [
                        {
                          "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe06fd",
                          "product_id": "68cf1234567890abcdef1234"
                        },
                        {
                          "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe06fe",
                          "product_id": "68cf1234567890abcdef1235"
                        }
                      ]
                    }
                  },
                  {
                    "id": "4c9884c0-e8ba-42e2-bde2-63c703bce086",
                    "type": "column",
                    "props": {
                      "gap": "sm",
                      "padding": "none"
                    },
                    "children": [
                      {
                        "id": "4c9884c0-e8ba-42e2-bde2-63c703bce087",
                        "type": "catalog_list",
                        "props": {
                          "display_type": "slider",
                          "card_style": "product_card",
                          "limit": 10,
                          "items": [
                            {
                              "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe06ff",
                              "name": {
                                "en": "Example brand",
                                "ar": "علامة تجارية تجريبية"
                              },
                              "image_url": "https://media.petyardstores.com/ui-builder/example-brand.webp",
                              "action": {
                                "type": "brand",
                                "value": "68cf1234567890abcdef1237"
                              }
                            },
                            {
                              "id": "d72b5f6c-9a65-49c5-a7e3-9f5374fe0700",
                              "name": {
                                "en": "Cats",
                                "ar": "القطط"
                              },
                              "image_url": "https://media.petyardstores.com/ui-builder/example-category.webp",
                              "action": {
                                "type": "category",
                                "value": "68cf1234567890abcdef1238"
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                ]
              },
              {
                "id": "fb97f598-d1d3-4a37-8776-6b1c88f03c67",
                "type": "image",
                "props": {
                  "image_url": "https://media.petyardstores.com/ui-builder/example-second-banner.webp",
                  "aspect_ratio": "4:3",
                  "fit": "contain",
                  "border_radius": "sm",
                  "alt_text": {
                    "en": "More treats",
                    "ar": "المزيد من المكافآت"
                  }
                }
              },
              {
                "id": "b6a23fb3-b048-40e1-85a4-40b92ef06cd1",
                "type": "divider",
                "props": {
                  "color": "muted"
                }
              },
              {
                "id": "b6a23fb3-b048-40e1-85a4-40b92ef06cd2",
                "type": "spacer",
                "props": {
                  "size": "sm"
                }
              },
              {
                "id": "b6a23fb3-b048-40e1-85a4-40b92ef06cd3",
                "type": "button",
                "props": {
                  "label": {
                    "en": "View a special pick",
                    "ar": "شاهد اختياراً مميزاً"
                  },
                  "variant": "primary",
                  "size": "medium",
                  "action": {
                    "type": "product",
                    "value": "68cf1234567890abcdef1236"
                  }
                }
              }
            ]
          }
        }
      }
    ],
    "navigation": {
      "items": [
        {
          "key": "home",
          "label_key": "home",
          "icon_key": "home",
          "destination": "home",
          "order": 0,
          "enabled": true
        }
      ]
    }
  },
  "change_note": "Prepared product-ID and block format; draft example only."
}
```

Response is HTTP 200 with the same complete draft dictionary shown above, now revision 2, changed name/targeting/content/change_note and updated_at. Server content retains both languages, all eight blocks, 11 nodes, four product-card placements and the product button; product_ids contains three unique products. No presentation fields are inserted into product items.

Persist the acknowledged response separately from any newer unsent editor changes. Retain the exact original body/If-Match/mutation key while outcome is uncertain. Next logical save uses the latest acknowledged revision and a new mutation UUID. Full replacement means deleting a section/prop locally deletes it from the next stored snapshot; no server merge is performed.

### 12.4 Read and validate the acknowledged revision

GET `/api/v1/admin/home-layouts/drafts/<draftId>` returns current draft dictionary. Save content exactly into a wire-snapshot store, then hydrate a separate editor model. Do not overwrite a dirty local editor merely because GET succeeds.

POST `/api/v1/admin/home-layouts/drafts/<draftId>/validate` with `{}`; no revision/key is required. It validates the current saved revision and writes a validation audit event, not a published version.

```json
{
  "data": {
    "valid": false,
    "draft_id": "8ec682ef-aacd-4639-9d23-b98ea8234dbe",
    "revision": 2,
    "errors": [{
      "path": "targeting.min_app_version",
      "code": "CLIENT_VERSION_UNSUPPORTED",
      "message": "New-format publication is disabled until the first compatible customer-app version is configured."
    }],
    "warnings": [],
    "validated_at": "2026-10-06T09:05:00Z"
  },
  "meta": {"request_id":"c15a5c93-bc1c-4631-a647-a31054e1c7e6"}
}
```

This example assumes all structure/references are valid; other current issues can add findings. HTTP 200 means the validation request completed, not valid:true. Retain revision only as the revision inspected, errors for editor highlighting, and validated_at for display. Do not treat this report as a permanent publication permission: later changes invalidate it and publication rechecks.

### 12.5 Preview without activating the release

POST `/api/v1/admin/home-layouts/drafts/<draftId>/preview`:

```json
{"revision":2,"expires_in_seconds":1800,"device_profile":"phone","locale":"ar","platform":"android"}
```

revision comes from acknowledged save; expiry is optional integer 60..3600 (default 1800). Optional device_profile is nonblank <=40, locale is supported locale syntax, platform is android/ios/web, location_id is a UUID/ObjectId. They are returned hints, not target mutation or server text translation. No min/max version, country, audience or arbitrary context keys are accepted here.

```json
{
  "data": {
    "preview_id": "41c679c2-e07b-4b04-a215-04caedc5c4a5",
    "token": "EXAMPLE_ONLY_NOT_A_REAL_PREVIEW_TOKEN_0123456789",
    "expires_at": "2026-10-06T09:35:00Z",
    "revision": 2,
    "preview_url": "/api/v1/home-layout/preview?token=EXAMPLE_ONLY_NOT_A_REAL_PREVIEW_TOKEN_0123456789"
  },
  "meta": {"request_id":"347e4ce7-d5ce-46b1-b38d-f2a0708e5914"}
}
```

Join the returned relative preview_url to the API origin, or URL-encode token in GET `/api/v1/home-layout/preview?token=...`. Returned data fields are layout_id, version_id:null, version_number:null, schema_version:1, published_at:null, checksum, sections, navigation, product_reference_format and product_ids. The full saved fixture's content is flattened directly under data. FAB stays omitted. Meta contains preview:true, draft_id, revision, requested_context and request_id.

Preview is immutable; save/GET/publication does not refresh it. Recreate after editing. Complete reference/content checks apply, but new-profile preview skips the compatible-release gate and active-target overlap/global checks. Tokens are temporary secrets; reads are no-store/private and must not enter published caches. Creation is limited to 30 per IP/15 minutes; reads to 60. DELETE `/api/v1/admin/home-layouts/previews/<preview_id>` revokes it, returns 204 without JSON. Expired/revoked token returns 410; missing token/record returns 404.

### 12.6 Hydrate editor/customer from the snapshot, not from copied commerce fields

Call the batch API once using preview/public data.product_ids. Build a Map keyed by canonical product id. Every card/typed product action can reuse that entry; retain placement UUIDs and child order.

For editor reopening, keep an exact normalized wire snapshot plus a separate hydrated editor view. Existing editor forms may need product name/image/variants; those are transient catalog fields, not additions to the ID-only wire item. Normalize again before every new PATCH. A brand/category manual item stays authored; do not replace its name/image with a whole product or expand its action into products.

For customer runtime, choose authored language without modifying the stored snapshot. Apply block renderer defaults without writing them back. Unavailable products become a safe non-purchasable fallback/omission according to the agreed FE renderer; a product button targeting an unavailable product must not pretend purchase is possible. Built-in sections keep their existing domain loading, separate from explicit manifest hydration.

### 12.7 Future publication: approved build, fallback, targeted save first

Only after FE adapters/device tests and explicit release approval, the release owner configures the confirmed supporting version. Illustrative isolated-test version 2.0.0 is not an approved customer release.

A compatible global legacy UI Builder layout must exist first. Clone/save the prepared draft with targeting.min_app_version at least the confirmed floor and an intentionally higher priority than an overlapping fallback; keep other target fields complete. That PATCH advances revision (for example, 2→3). Read/validate revision 3. Release requests never upload/save content implicitly.

Immediate release:

```http
POST /api/v1/admin/home-layouts/drafts/<draftId>/publish
Authorization: Bearer <super-admin-token>
Content-Type: application/json
Idempotency-Key: 955f87f8-16ef-44d8-9886-7476c9f97022
```

```json
{"revision":3,"mode":"now","change_note":"Approved custom Home release"}
```

Do not send scheduled_for with mode now, even null. Required note is nonblank <=500. Response HTTP 201 data has version_id, version_number, status:"published", published_at, checksum and superseded_version_id (null if no previous exact-scope pointer). Meta has request_id. Retain version_id for history/clone/rollback; retain status for UI; GET draft for current status. Source draft is now immutable/published, not editable.

### 12.8 Scheduling, observing and canceling

Same publish route/headers, new logical Idempotency-Key, body:

```json
{"revision":3,"mode":"schedule","scheduled_for":"2026-11-01T09:00:00Z","change_note":"Approved November Home"}
```

Replace time with a real future UTC instant at least two minutes ahead of the server. Never append Z to a local clock. Scheduling needs server publication enabled plus configured Redis; capability true does not prove worker health.

HTTP 201 data has draft_id, status:"scheduled", revision, scheduled_for, and optional queue_pending:true if acceptance committed but enqueue awaits reconciliation. No version_id/checksum yet: the version is created at execution. Keep draft_id/revision/time and poll GET draft as needed; no fixed instant completion guarantee. Redis retries/reconciliation recover queue delivery, while reference/version checks run again at execution. Failure sets schedule_failure and leaves the previous public version intact.

To edit/reschedule/publish now, POST `.../drafts/<id>/cancel-schedule` with {}. Success 204 has no JSON. GET the draft; it is draft with an advanced revision and cleared scheduling state. Do not keep the old revision/key for a different schedule. A publication/cancellation race can return a state conflict: refresh, preserve edits, and clone the published version if publication already won.

### 12.9 Customer public read and HTTP cache reuse

GET `/api/v1/ui-layouts/customer_home` with actual X-App-Version, X-App-Platform, X-App-Locale; send X-Country-Code/X-Location-Id only from the agreed business sources when known. Optional valid bearer selects logged_in; no bearer selects guest. Invalid bearer is not silently ignored.

Data contains layout_id, version_id, version_number, schema_version:1, published_at, checksum, sections, navigation, plus the new profile/manifest only if a compatible new version was selected. No targeting, draft revision, change_note, private editor state or FAB appears in that public body. Meta contains cache_ttl_seconds:0 and request_id. Legacy fallback has no new profile fields.

Store the whole successful snapshot, its ETag, and the exact request context together. Send unchanged ETag in If-None-Match only for that context. 304 has no JSON body; reuse that context's stored snapshot. A 304 without a cached body requires a fresh unconditional GET. Server cache identity includes publication epoch, targeting context and configured compatible minimum; publication/rollback changes epoch. This does not prove the deployed Redis cache has been accepted.

Keep product hydration scoped to identity, locale and effective warehouse, separately from layout targeting. A layout 304 does not assert product stock/prices/favorites are unchanged; refresh catalog data according to the product integration policy. Never reuse an admin's inactive/all-language products as customer data.

### 12.10 History, cloning, rollback, lists and archive

GET `/api/v1/admin/home-layouts/history?limit=20`: items are complete version dictionaries plus history status published/superseded. Published means currently active for a scope; multiple scopes can have published entries. GET `.../versions/<version_id>` returns the same immutable content without history status. Version fields: version_id, layout_id, version_number, schema_version, targeting, content, checksum, source_draft_id, rollback_of_version_id, change_note, published_at, published_by. IDs/metadata are server-owned; content is nested here for admin use. source_draft_id links ordinary release to a draft; rollback_of_version_id identifies historical rollback lineage; null is meaningful. History next_before is a numeric version cursor, not an opaque draft cursor.

Clone through the existing POST drafts body:

```json
{"layout_key":"customer_home","name":"Next custom Home edit","source":{"type":"published","version_id":"6fe0c45d-fd48-44d5-b9c8-d3794b0e9607"}}
```

Use a real version_id. New draft ID/revision 1 are returned; based_on_version_id identifies source, and the complete profile/target/content/UUIDs are copied. It is not a draft-to-draft or section-template clone endpoint. Copying a whole version into a separate draft does not require changing its internal identities; duplicating a section within one layout does.

Rollback POST `/api/v1/admin/home-layouts/versions/<version_id>/rollback` with a new Idempotency-Key and `{"change_note":"Restore the approved layout"}`. No draft revision is sent. HTTP 201 returns new publication metadata, not the old version itself. Old content/profile/targeting is revalidated against current references, compatibility and target overlap; failure does not change active content. For changing the old target, clone it, edit and release instead.

GET drafts allows limit default20, before opaque cursor, status draft/scheduled/published/archived. GET audit allows limit default20 and before opaque cursor. All limits 1..100. Response data.items/next_before; audit item fields action, draft_id, version_id, actor_id, request_id, details and created_at describe server events, not editable content. Scope cursors to query/endpoint; do not construct from visible timestamps.

DELETE drafts/<id> archives only status draft and returns 204. Scheduled must be canceled first; published work requires a new draft. No restore endpoint exists; preserve local work before archive. Archive does not remove live version, products, assets or FE templates.

## 13. Batch API: every request and response field

### 13.1 Send only the snapshot's unique list

```http
POST /api/v1/products/batch?warehouse=<optional-real-warehouse-id>
Content-Type: application/json
Accept-Language: ar
Authorization: Bearer <optional-valid-customer-token>
x-guest-id: <existing-guest-id-if-not-authenticated>
```

Warehouse is the existing product-detail query parameter, not a new location header. Omit Authorization for guests. Logged-in identity wins over guest ID; changing account/logout must invalidate personalized cached data.

```json
{"ids":["68cf1234567890abcdef1234","68cf1234567890abcdef1235","68cf1234567890abcdef1236"]}
```

ids is the only body key: array of <=50 supplied 24-hex strings before deduplication. IDs normalize to lowercase; first-use order is retained. <=2048 raw/inflated UTF-8 JSON bytes, including whitespace. Only query warehouse is accepted and must be an ObjectId. Locale uses existing Accept-Language behavior (ar/en, default en); X-App-Locale targets layouts but does not replace this product locale contract.

No mutation UUID, revision, release key or new product schema discriminator is sent. Empty ids returns empty products/unavailable arrays without product queries; FE should skip that call.

### 13.2 Complete detail DTO dictionary, not a reduced card

HTTP 200 envelope is data.products (complete objects below) and data.unavailable_product_ids (requested IDs unavailable under this context). There is no required success/meta flag on this product response. Match by product.id, not array index. Every unique requested ID appears exactly once in one of these arrays. A missing product does not discard available products or expose detailed private reasons.

| Product field | Origin / meaning | FE storage/use and important null/optional behavior |
| --- | --- | --- |
| id | Product ObjectId from catalog. | Key shared product map; never a placement UUID. |
| slug | Existing product slug. | Product routing/display where existing app uses it. |
| type | SIMPLE or VARIANT. | Select existing variant-aware commerce/rendering logic. |
| isActive | Current catalog visibility. | Customers only receive active products; authorized staff can see inactive. |
| category/subcategory/brand | Existing referenced entity, localized by product API. | null, id wrapper, or populated id/slug/name; not authored layout fields. |
| name/desc | Localized catalog strings. | Render product truth; do not persist in ID-only placements. |
| name_en/name_ar/desc_en/desc_ar | Authorized product-management staff only. | Optional privileged fields; ordinary customer does not receive them. |
| sku | Catalog SKU or null. | Existing catalog/commerce behavior. |
| tags | Existing catalog tag array. | Retain as DTO; not builder metadata. |
| price/discountedPrice | Existing pricing projection. | SIMPLE numeric/null; VARIANT top-level values are null and variant values remain usable. Null discountedPrice means no projected discount. |
| promotion | Existing winning promotion metadata or null. | collectionId, collectionSlug, discountPercent. Backend chooses existing direct-product > category ancestry > brand priority. |
| stock/inStock | Existing effective warehouse or aggregated stock / availability boolean. | Context-dependent; do not replace checkout validation with cached builder data. |
| images | Existing ordered image objects. | Each public_id/url/isMain; use actual public URL. |
| mainImage | Main image URL or null. | Existing product card fallback; not an image UUID. |
| options | Existing product option definitions. | Optional; each name/values; preserve the detail contract instead of forcing a layout shape. |
| variants | Existing priced variant details. | Optional for simple products; see nested dictionary below. |
| warehouseStocks | Existing simple-product stock rows for this context. | Each warehouse/quantity, optional permission-scoped revision; do not invent location-based stock. |
| ratingAverage/ratingCount | Existing numeric catalog ratings (default0). | Render existing product rating presentation. |
| isFavorite | Identity-specific favorite lookup. | Refresh when identity changes; no favorite mutation occurs here. |
| isRestockNotificationRequested | Identity/product/effective-warehouse subscription state. | False without applicable identity+warehouse; not a subscription creation API. |
| media | Existing image/video gallery projection. | Array with image entries; video entries only when the separate video public feature permits them. |

| Nested field | Meaning / use |
| --- | --- |
| variants[].id / index | Variant ObjectId or null / existing array index; use actual identity for selection. |
| variants[].sku | Variant SKU or null. |
| variants[].price / discountedPrice | Existing base/projected discount, numeric or null; do not reject valid variants because product.price is null. |
| variants[].options[].name / value | Existing selected option pairs. |
| variants[].imageIndex | Product-image array index corresponding to variant image, or null. |
| variants[].images[].url | Variant public image URL. |
| variants[].warehouseStocks | Context stock rows with warehouse, quantity, optional authorized revision. |
| variants[].stock / inStock / isDefault | Existing stock sum / boolean availability / default-variant flag. |
| warehouseStocks[].warehouse / quantity / revision | Warehouse identity / quantity / optional staff-only optimistic-stock revision. No stock write is made by batch. |
| media image id/type/position | Existing gallery identity, type image, zero-based order. |
| media image public_id/url/isMain | Same image source/public URL/main flag as product media contract. |
| media video id/type/position | Existing editorial video ID, type video, projected gallery order. |
| media video posterUrl/durationSeconds/width/height/aspectRatio | Existing poster (nullable), duration and dimensions for rendering; not builder configuration. |
| media video canSave/playbackHref | Existing false save-permission hint / relative protected playback-resolution route. Use the video's existing integration; do not derive signed storage URLs. |

This endpoint reuses product-detail serialization. Fields absent in JSON because they are undefined are not silently missing from a new reduced DTO. Existing product-domain behavior remains authoritative; this documentation does not introduce video activation, new prices or variant purchase rules.

### 13.3 A complete illustrative partial-success response

Two products returned together; the third is unavailable. The examples below are SIMPLE products, so optional options/variants are absent. Real DTO values/arrays come from the current catalog, not this document.

```json
{
  "data": {
    "products": [
      {
        "id":"68cf1234567890abcdef1234","slug":"example-cat-food","type":"SIMPLE","isActive":true,
        "category":{"id":"68cf1234567890abcdef1238","slug":"cats","name":"Cats"},
        "subcategory":null,"brand":null,"name":"Example cat food","desc":"Example description",
        "sku":"EXAMPLE-A","tags":[],"price":100,"discountedPrice":null,"promotion":null,
        "stock":5,"inStock":true,
        "images":[{"public_id":"example-a","url":"https://media.petyardstores.com/example-a.webp","isMain":true}],
        "mainImage":"https://media.petyardstores.com/example-a.webp",
        "warehouseStocks":[{"warehouse":"68cf1234567890abcdef1240","quantity":5}],
        "ratingAverage":0,"ratingCount":0,"isFavorite":false,"isRestockNotificationRequested":false,
        "media":[{"id":"image:example-a","type":"image","position":0,"public_id":"example-a","url":"https://media.petyardstores.com/example-a.webp","isMain":true}]
      },
      {
        "id":"68cf1234567890abcdef1235","slug":"example-cat-treats","type":"SIMPLE","isActive":true,
        "category":null,"subcategory":null,"brand":null,"name":"Example cat treats","desc":"",
        "sku":null,"tags":[],"price":200,"discountedPrice":180,"promotion":null,
        "stock":2,"inStock":true,"images":[],"mainImage":null,
        "warehouseStocks":[{"warehouse":"68cf1234567890abcdef1240","quantity":2}],
        "ratingAverage":4,"ratingCount":2,"isFavorite":true,"isRestockNotificationRequested":false,"media":[]
      }
    ],
    "unavailable_product_ids":["68cf1234567890abcdef1236"]
  }
}
```

Use this only as shape documentation. An Arabic request will use actual localized catalog values; no illustrative field above is real inventory, identity state or an approved CDN reference.

### 13.4 Context, read-only guarantees, bounds and failures

Products are loaded by set queries, not self-HTTP detail calls. Pricing, DTOs, favorite/restock/media logic are reused; no product/stock/order/favorite mutation or expired-promotion maintenance write runs here. Primary product/video queries have a 10000ms server query bound; supporting helpers retain driver behavior, so this is not a 10-second total HTTP promise.

Responses are private/no-store; do not create a shared personalized client cache. Customer/guest active-product visibility and authorized staff field/warehouse rules match the detail endpoint. Moderator scope checks still apply.

Complete response <=2097152 bytes; excess returns 413 without truncation. The copied catalog's largest tested 50 products fit in English/Arabic for guest/customer/staff, largest measured 1,437,983 bytes. This is not an unlimited future-data guarantee. If growth needs lower limits or bounded chunking, agree it with FE; do not silently switch to per-product detail calls or change limits.

Rate limit is 60 requests per IP/15 minutes, with standard headers. Network/database/whole-service failure is an error, not products:[] success. Handle 400 input/query errors, 401 invalid token, 403 forbidden staff context, 413 body/result bounds, 415 unsupported content/encoding, 429 rate limit and 5xx failures. Ordinary product errors use existing status/error/message; rate-limit body is status/message. Development middleware may add stack; do not depend on it or display it. UI Builder's error.code parser is a different envelope.

## 14. Offline work, upgrades, duplication and uncertain outcomes

Retain an acknowledged wire snapshot, working editor snapshot, acknowledged server revision, dirty marker and pending request record separately. A useful local pending PATCH record contains method/path, exact body, original quoted If-Match, X-Client-Mutation-Id and its base revision. Do not store auth tokens in that record's exported JSON.

For legacy→new upgrade: create/open an editable draft, resolve any pending legacy save unchanged, GET its current revision, normalize the complete chosen document, insert the discriminator/exact manifest, then send a new logical PATCH. Do not mutate an existing pending body but keep its old retry key. No automatic published-record conversion runs.

For new-profile→legacy conversion: do not simply remove the discriminator/manifest. Composed sections, bilingual maps and ID-only cards do not satisfy legacy schemas. An intentional editor conversion needs supported legacy sections/items/strings and a freshly constructed complete snapshot; preserve original work.

To duplicate a section inside the same layout, create a new section UUID and regenerate every nested node/item UUID in the copy. Keep selected product IDs unchanged, adjust positions, rebuild manifest. To edit/reorder an existing instance, keep UUIDs stable. Duplicating one product card adds a new placement UUID, not a second manifest entry. Server cloning an entire version into a separate draft keeps its contained IDs.

If a save times out, retry the exact pending request; identical retry returns the saved result without another revision. Changed body with the same key produces UI_MUTATION_KEY_REUSED. A conflict requires GET, base/local/server review, explicit resolution and a new logical save. Never force a stale document over a newer revision silently. An acknowledged replay can be older than the current server state; GET again before the next operation and do not lower a newer known revision.

Serialize autosaves. Edits made while request A is in flight stay dirty; acknowledge A without losing them, then save B against the returned revision with a fresh key. On app restart, recover the pending operation before issuing a different one. Clearing dirty state must not discard newer edits.

Publish/schedule/rollback retries keep the exact Idempotency-Key/body/path; reuse with changed request is rejected. Do not queue a new release automatically while offline. Create/upload/preview creation do not gain idempotency from these headers; uncertain outcomes can create duplicate drafts/assets/previews and require conscious recovery. DELETE/cancel return no JSON on success; they are state operations, not release-key deduplicated mutations.

## 15. Errors, edge cases and which request comes next

UI Builder operational failure envelope has error.code, message, request_id and details. Details usually contain path/code/message field findings; revision-conflict details can instead be an object with expected_revision/current_revision/updated_by/updated_at. Do not assume details is always an array.

A validate response puts errors/warnings under data and can be HTTP 200 with valid:false. A rejected PATCH/preview/publish uses the error envelope, usually 422 for content findings. Malformed headers/body shape use 400; auth 401/403; state/retry conflicts 409; preview expiry 410; release disabled/unconfigured queue 503. Follow the actual status and code, not an invented all-errors-200 rule.

| Finding / event | Meaning | Correct next step |
| --- | --- | --- |
| UNSUPPORTED_PRODUCT_REFERENCE_FORMAT | New fields without id_only_v1, unknown profile, or composed section in legacy. | Normalize a complete supported profile; new logical PATCH. |
| INVALID_PRODUCT_ID / INVALID_REFERENCE_ID | Wrong ObjectId type/syntax. | Use the actual entity API id; never node UUID/numeric label. |
| PRODUCT_MANIFEST_INVALID / PRODUCT_MANIFEST_LIMIT_EXCEEDED | Missing/non-array manifest or more than 50 explicit products. | Reduce explicit distinct choices; never truncate silently. |
| PRODUCT_MANIFEST_DUPLICATE | Repeated list ID, including case aliases. | Deduplicate manifest only, preserving all placements. |
| PRODUCT_MANIFEST_MISMATCH | Extra/missing manifest entry. | Recollect every retained product/action, then save full document. |
| PRODUCT_ITEM_REQUIRES_ID / UNKNOWN_FIELD | Copied product presentation/action in manual product shape or extra prop. | Emit exact id/product_id; keep editor enrichment outside wire data. |
| BLOCK_TYPE_UNSUPPORTED / BLOCK_ROOT_INVALID | Unsupported node/root type. | Use eight types and root column. |
| BLOCK_PROP_INVALID / BLOCK_CHILDREN_UNSUPPORTED | Bad enum/unknown prop/children on a leaf. | Correct the indicated node; do not replace with arbitrary dimensions. |
| BLOCK_DEPTH_EXCEEDED / BLOCK_NODE_LIMIT_EXCEEDED / BLOCK_CHILD_LIMIT_EXCEEDED | Depth >6, nodes >50, children >12. | Simplify within agreed bounds; full snapshot retains intended order. |
| DUPLICATE_ID | Duplicate section or node/item identity in its uniqueness scope. | Generate new copy identities, not new catalog product IDs. |
| INVALID_ITEMS | Wrong list type/count or empty publish-ready list. | Correct list; empty can remain an incomplete draft only. |
| LOCALIZED_TEXT_INVALID / INVALID_STRING | Wrong map keys/types/length or required blank text. | Correct authored values; do not flatten both languages automatically. |
| IMAGE_REQUIRED / INVALID_HTTPS_URL / ASSET_NOT_READY | Missing unsafe/unregistered image. | Upload/select a ready exact URL; PATCH, validate, recreate preview. |
| PRODUCT_REFERENCE_UNAVAILABLE / REFERENCE_NOT_PUBLIC | Current product/entity unavailable. | Reselect/remove reference consciously, rebuild manifest and save. Disabled content is not exempt. |
| NON_CONTIGUOUS_POSITION | Invalid new-profile publish ordering. | Use array-order positions 0..n-1, save and validate. |
| HOME_NAVIGATION_REQUIRED | No enabled Home item. | Restore fixed enabled Home then save. |
| CLIENT_VERSION_UNSUPPORTED | Supporting release floor missing/unconfigured/too low. | Continue preparation/preview; coordinate release. Never guess a min version. |
| GLOBAL_LAYOUT_REQUIRED / TARGETING_OVERLAP | Missing fallback or colliding equal-priority scope. | Coordinate fallback/target priorities; new target save before release. |
| UI_DRAFT_IF_MATCH_REQUIRED | Missing/nonquoted draft revision. | Use latest acknowledged revision as quoted header. |
| UI_DRAFT_REVISION_CONFLICT / UI_DRAFT_NOT_EDITABLE | Server moved or draft locked/frozen. | GET and review; cancel schedule or clone version when appropriate. |
| UI_MUTATION_KEY_REUSED / UI_IDEMPOTENCY_KEY_REUSED | Same logical key with different request. | Resolve original operation; new key only for a truly new operation. |
| UI_LAYOUT_RELEASE_DISABLED / UI_SCHEDULE_UNAVAILABLE | Server release/queue configuration unavailable. | Keep saved work; release owner resolves environment, not a new JSON field. |
| Preview 404/410/429 | Missing/expired/revoked/rate-limited capability. | Create a fresh saved-revision preview or wait per rate limit; do not bypass. |
| Batch partial unavailability | Some unique IDs were not loadable. | Keep successes; safe unavailable UI; do not invent substitutes/commerce. |
| Batch 413/429/5xx | Size/rate/service failure, not successful missing products. | Show explicit failure; back off or agree bounded loading changes; preserve the layout. |
| Public 304 | Unchanged layout in this context. | Reuse only its matching cached snapshot; stock/favorites may still need refresh. |
| Product deleted after publication | Layout remains immutable; batch reports unavailable. | Safe non-purchasable rendering; explicit admin revision if replacement is desired. |

Runtime errors/reference states can change between validation and release; the release/worker rechecks and preserves active content on failure.

A public read never repairs/deletes the active version. A failed transaction leaves prior active pointers/history/draft state intact. Rollback can fail if historical assets/products disappear or current gates reject it; it is not a guaranteed bypass.

## 16. Release configuration, verification and rollback boundaries

| Server variable | Source / purpose | Relationship |
| --- | --- | --- |
| UI_BUILDER_PUBLISH_ENABLED | Existing encrypted server environment; literal true enables release routes. | Catalog publish_now; required for now/schedule/rollback. Does not imply a compatible new renderer. |
| UI_BUILDER_ID_ONLY_MIN_APP_VERSION | Release owner's confirmed customer version; strict x.y.z. | Unset/invalid disables new-profile publication. Catalog id_only_min_app_version is null. No guessed value belongs in a FE request or .env. |
| UI_BUILDER_PUBLIC_CUTOVER_ENABLED | Existing encrypted server environment; keep false until approved cutover. | Only selects old /home-layout GET behavior; dedicated /ui-layouts/customer_home already exists. Does not remove old PATCH. |
| REDIS_URL | Existing queue/cache infrastructure configuration. | Configured queue required for schedules; actual worker/Redis health must be verified. Never send to FE. |
| BULLMQ_QUEUE_PREFIX | Existing server queue namespace. | Backend/worker must agree; not a layout field. |

Read actual capabilities from the chosen environment. They describe implementation and configured policy, not a promise of worker health, finished device integration or automatic FE adapter changes. Prepared draft storage can be true while component_tree/product_id_references release support is false.

Release sequence: finish adapters → verify device/shared hydration/cache behavior → confirm schema/manifest ordering/limits and released supporting version → configure that confirmed floor → ensure compatible global legacy UI Builder fallback → target new draft → validate/preview → publish after explicit approval → verify deployed customer selection/cache/worker → coordinate old GET cutover separately. Keep old schemas/versions and pending legacy bodies intact.

To roll back content, use version rollback with its current checks and a new operation key. To suspend new-profile resolution, release owners may remove the configured floor through an approved environment change; resolver skips now-incompatible candidates without rewriting active versions. That policy operation is not authorized by this documentation task. No automatic campaign end, active-scope deletion, template migration or version archival exists.

### Verification evidence and remaining acceptance

Verified 6 October 2026: 85 focused regression tests and 12 neighboring collection/substitution tests passed. Real copied-cluster MongoDB/HTTP proved multi-product complete-detail parity, partial missing IDs, new-profile tree/map/manifest round-trips, retries, preview, publish/history/clone/rollback/ETag, old-client fallback and injected transaction-abort safety. The largest 50 active copied BSON products passed six English/Arabic×guest/customer/staff response checks. Real multipart processing/public WebP and delayed publication through owned local Redis/BullMQ/reconciliation passed. Owned temporary database collections, provider object and Redis instance were removed and absence verified.

This is separate from deployed cache acceptance: application caching was disabled in the lifecycle run. Synthetic test floor 2.0.0 did not change real release policy. Mobile rendering, offline Hive, auth/locale/warehouse client cache isolation and the approved customer build still require FE/device acceptance. Current changes are not an announcement of commit/push/deployment.

Repeatable local command, without loading .env infrastructure into the focused tests:

```powershell
$uiTests = (Get-ChildItem -LiteralPath 'test/domains/uiLayout' -Filter '*.test.js').FullName
node --test --experimental-test-isolation=none --test-concurrency=1 $uiTests test/domains/product/productBatch.test.js test/domains/productAdminDetailList.test.js test/domains/productWarehouseStocks.test.js test/domains/productImageUpdates.test.js test/domains/videos/public/productMedia.test.js
```

Real resource tests use scripts/testUiLayoutIdOnlyIntegration.js with explicitly approved copied-cluster URI and opt-in media/local Redis settings described earlier. Do not run casually against existing .env Mongo/Redis, publish live records, or put credentials in docs/Postman examples.

## 17. Backend source changes and FE acceptance checklist

| File / seam | Added or changed responsibility |
| --- | --- |
| uiLayout.constants.js / catalog.js | Profile/tree bounds, conditional catalogs, block/default/token/loader declarations. |
| uiLayout.fields.js / blocks.js | Shared pure field validation; exact approved props, localized text and item/node bounds. |
| uiLayout.productReferences.js | One owned collector, exact manifest checks and lowercase/canonical ordering. |
| uiLayout.contract.js | Conditional new-profile content validation; legacy support and flattened public profile. |
| uiLayout.references.js | Set-based product/entity/media readiness checks for new profile; legacy compatibility. |
| uiLayout.compatibility.js / service.js | Confirmed renderer floor, preview preparation exception, release/rollback/worker/public compatibility and preserved content. |
| productBatch.constants.js / contract.js / middleware.js / service.js | Shared 50-ID limit, owned request parser, raw JSON bound and read-only set-based complete details. |
| product.limiters.js / routes.js / validators.js / controller.js | Batch IP limiter, additive route, owned input validation and existing identity/context handoff. |
| product.service.js / repository.js | Reuse/export complete mapper/favorite logic and composable existing query path. |
| collection.promotion.js | Shared parent-map batch promotion lookup with existing priority. |
| src/app/server.js | Batch raw parser before global JSON parser. |
| videos/public/productMedia.service.js / publicProductVideo.repository.js | Existing media projection reused with set-based multi-product reads; not video release activation. |
| test/domains/uiLayout and test/domains/product/productBatch.test.js | Profile/fixture/bounds/retries/reference/auth/context/read-only regressions. |
| test/fixtures/uiLayout.idOnly.json | Complete FE revision-2 eight-block fixture. |
| scripts/testUiLayoutIdOnlyIntegration.js / .gitignore | Guarded repeatable real acceptance script and tracking exception. |

UI files in this table are under src/domains/uiLayout; product files under src/domains/product; collection under src/domains/collection. Existing routes→validators→controller→service→repository/model boundaries remain. No new package is required for this extension. Unrelated Videos/Prime changes in the checkout are not part of this handoff.

Before marking FE integration complete, verify:

- Catalog discovers the profile and eight types; draft-storage vs release flags are handled separately.
- Outgoing save is a complete normalized snapshot, not a local template/editor object. Pending legacy saves remain unchanged.
- Reopen/clone hydrates editor presentation separately from the exact wire shape and preserves maps/UUIDs/order/omitted props.
- Full fixture shows four cards and one product button from one three-ID batch, not per-placement detail requests.
- Missing/extra/duplicate manifest, all tree/count/security boundaries and inactive/deleted references have readable recovery.
- Partial unavailability, variant null top-level price, empty list, 413/429/service errors, identity/locale/warehouse changes and stale catalog data are tested.
- Preview is frozen/no-store; secrets expire/revoke and never mix with published caches.
- Save/release retries and restart/offline conflicts retain operation identity without losing later edits.
- Supporting version is actually released, fallback exists and incompatible/missing-version clients never receive unsupported trees/maps.
- New-profile now/schedule/rollback are blocked until approved compatibility; failed release preserves active content.
- Deployed worker/cache/media and Android/iOS renderer behavior have explicit evidence before cutover.

## 18. Subcategories and banner carousels: October production handoff

Source: FE `PHASE_BACKEND_PRODUCTION_HANDOFF.md`, 2026-10-14. Implementation checked locally on 2026-10-15. These are additive changes to schema version 1, not new routes or a deployment announcement. The full acceptance response is [UI_BUILDER_PRODUCTION_HANDOFF_RESPONSE.md](UI_BUILDER_PRODUCTION_HANDOFF_RESPONSE.md).

The human confirmed that no customer build supporting blocks, subcategories and carousels together is approved. Drafts and authorized previews can prepare the new content; publication remains blocked. Do not enable legacy Home cutover to use the dedicated customer route.

### Change inventory

| Area | Current addition | What stays unchanged |
| --- | --- | --- |
| Actions | Typed `subcategory` destination in promos, dynamic section actions, manual cards and buttons. | Fixed app navigation, product item shape and product action behavior. |
| Image blocks | Optional ordered `image_urls` array, 1–10 distinct approved URLs. | Existing `image_url`, image ratios/fit/radius/alt text and image upload policy. |
| References | Every slide and subcategory validated; registered subcategory artwork can be reused by its exact stored URL. | Existing ready-library/catalog checks; removing references never deletes assets. |
| Catalog | New schemas, `max_banner_images`, draft/release capabilities and an extension renderer floor. | Existing core profile and release flags, schema version 1 and eight block types. |
| Lifecycle | New fields retained through saves, previews, checksums, history, clones, schedules and rollback. | Whole-layout replacement, revision locks and operation-key behavior. |
| Runtime | Extension compatibility is checked at validation, publication, worker execution, rollback and public resolution; floor is included in the server cache key. | Older layouts retain their existing compatibility rules and older clients retain matching fallback. |

No per-slide action/timer, template service, product snapshot, automatic product expansion, new image provider or new route was added.

### Every new field: origin, purpose and retained state

| Field | Origin and type | Usage, dependencies and what to retain |
| --- | --- | --- |
| `action.type:"subcategory"` | Admin selects a browse destination advertised by catalog. | Same typed `action` object as other destinations; not a navigation item key or Product Video relationship. |
| `action.value` | Real `id` from the existing subcategory picker; 24-hex ObjectId. | Backend checks existence under the normal catalog policy and canonicalizes the ID. Save it with that authored action. The subcategory model has no active flag; no new eligibility rule is invented. Missing destinations produce a finding at that action's field path. |
| `image_url` | One exact ready asset/catalog URL. | Continue using this for a single-image block. Omit `image_urls` completely, not null. |
| `image_urls` | Ordered URLs from individual completed uploads/library selections or approved exact catalog media. | Array of 1–10 distinct nonempty safe HTTPS strings. Preserve every slide and its order. Array form with one URL is accepted, though FE normally uses `image_url` for one. Omit `image_url` completely. Never send binary data, asset UUIDs, local paths or DTOs here. |
| `alt_text` | Existing authored literal or EN/AR map, max 120 per language. | Describes the image block; no per-slide caption schema was added. Preserve the authored languages. |
| `limits.max_banner_images` | Server catalog integer 10. | Editor array bound; does not change the 30-section, 50-product or overall UTF-8 payload bounds. |
| `capabilities.banner_carousel_draft_storage` | Server capability true after deployment of this implementation. | Permit complete carousel draft synchronization; not permission to publish. |
| `capabilities.banner_carousel` | Server release flag plus valid core and extension renderer floors. | Gate carousel release UI; not proof that physical-device acceptance passed. |
| `capabilities.subcategory_actions_draft_storage` | Server capability true after deployment. | Permit the new action in saved drafts. |
| `capabilities.subcategory_actions` | Server release flag plus valid extension renderer floor. | Gate release of any subcategory action, including legacy-shaped custom sections. |
| `extensions_min_app_version` | Server catalog; strict x.y.z or null. | Minimum approved renderer for this extension. Do not PATCH this catalog field. A release owner's environment setting supplies it. Null blocks extension release, not ordinary legacy publication. |

Both source keys together fail even in a draft. Omission of both can remain an incomplete draft; completed preview/publication requires one source. An explicit null, empty array, unknown property, unsafe URL or duplicate is not silently repaired.

A subcategory browse action does not fetch/expand products into the layout. Keep `content.product_ids` for explicit product placements and product actions only. Category, brand, subcategory and node UUIDs never belong in it. Disabled content and items beyond a visual limit are still checked.

### Existing picker routes and completeness

1. GET `/api/v1/subcategories` supplies `data` as a complete nested tree, not an ordinary paginated product response. Traverse `children` recursively so nested choices are not missed.
2. Optional `category=<ObjectId>` selects the category's tree. Optional `subcategory=<ObjectId>` returns that parent's children with descendants, excluding the parent itself. The existing service also supports `q` name search, retaining matching branches. Do not pretend `page/limit` paginate this tree.
3. Picker entries include `id`, `category`, `slug`, localized `name/desc`, `image`, `parent`, `children`, `updatedAt` and `isSubscribed`. Appropriate authorized staff also receive existing EN/AR fields. Use the real `id` for actions, not a displayed slug or parent category ID. Subscription state is unrelated to builder eligibility.
4. GET `/api/v1/products/admin?subcategory=<id>&page=1&limit=20&isActive=true` remains the existing authorized product picker. A single subcategory filter includes descendants. Category/brand filters remain available and combine with it.
5. Its existing page result includes `totalResults`, `totalPages`, `page`, `results` and product `data` in the ordinary success envelope. Fetch subsequent pages until the picker selection is complete; do not assume 20 choices are the whole catalog.
6. Image DTOs may contain transformed delivery URLs. Readiness validation recognizes exact stored/catalog URLs, not every arbitrary transform. Prefer ready UI Builder uploads if the selected URL is not the approved exact source. There is no permission to fetch/whitelist arbitrary external URLs.

### Exact preparation sequence

1. Authenticate as super-admin and GET the actual environment's catalog. Confirm both draft-storage capabilities and the new accepted schemas. An old deployed catalog cannot be upgraded by frontend flags.
2. Select existing subcategory IDs. Select/upload each image before a completed preview, retaining its ready `id/url` locally. Each upload is existing multipart `image` + `usage`; JPEG/PNG/WebP, at most 5 MiB, with existing real-byte/dimension checks.
3. Create/open a whole-layout draft. Retain `data.id`, latest `revision`, complete acknowledged targeting and content. Local section templates remain local; inserted copies receive independent UUIDs.
4. Save the complete normalized snapshot using quoted `If-Match` and a stable `X-Client-Mutation-Id` for that exact logical save.
5. Retain the successful server content/revision. Validate it. A release-floor error does not mean supported draft storage failed.
6. Issue a saved-revision preview. Every slide/destination must currently be usable; new renderer release approval is not required for this authorized preparation path.
7. Join the returned relative `preview_url` to the API origin. Keep token/preview ID privately for read/revoke. The response preserves the full image array and authored maps under flattened public-style `data`.
8. On edit, send a new full save with a new logical mutation ID, then recreate the preview. Old previews stay immutable. Resolve uncertain outcomes with exact retries, not new keys.
9. Stop before release until the supporting customer build and environment/actions are approved. No supporting version has been supplied now.

Complete illustrative PATCH body below: replace URLs and the subcategory ID with real approved selections. It contains no explicit product references, so its manifest is exactly empty. The name is an editor label, not the customer heading.

```http
PATCH /api/v1/admin/home-layouts/drafts/<actual-draft-uuid>
Authorization: Bearer <super-admin-token>
Content-Type: application/json
If-Match: "1"
X-Client-Mutation-Id: 72296096-c6d1-43d3-bb70-c16505332b2d
```

```json
{
  "name": "Subcategory offers",
  "change_note": "Prepare two slides and a browse button",
  "targeting": {
    "platforms": [], "locales": [], "country_codes": [], "location_ids": [],
    "min_app_version": null, "max_app_version": null, "audience": "all", "priority": 0
  },
  "content": {
    "product_reference_format": "id_only_v1",
    "product_ids": [],
    "sections": [
      {
        "id": "3ab92c12-414f-47bc-a801-ce63d77fe6e2",
        "section_type": "composed_section",
        "position": 0,
        "data": {
          "enabled": true,
          "root": {
            "id": "04f46e28-6720-4e10-9aa5-0a6af01ef90c",
            "type": "column",
            "props": {},
            "children": [
              {
                "id": "0b924497-0954-475d-9d51-f0d33f13b604",
                "type": "image",
                "props": {
                  "image_urls": [
                    "https://media.petyardstores.com/ui-builder/offer-one.webp",
                    "https://media.petyardstores.com/ui-builder/offer-two.webp"
                  ],
                  "aspect_ratio": "16:9",
                  "fit": "cover",
                  "border_radius": "md",
                  "alt_text": {"en": "Pet offers", "ar": "عروض للحيوانات الأليفة"}
                }
              },
              {
                "id": "bc2183db-841d-4104-96c2-28c74a1b890b",
                "type": "button",
                "props": {
                  "label": {"en": "Browse treats", "ar": "تصفح المكافآت"},
                  "action": {"type": "subcategory", "value": "68cf1234567890abcdef1238"}
                }
              }
            ]
          }
        }
      }
    ],
    "navigation": {
      "items": [
        {"key":"home","label_key":"home","icon_key":"home","destination":"home","order":0,"enabled":true}
      ]
    }
  }
}
```

PATCH still returns the full draft dictionary, now with these authored fields retained under `data.content`; it advances revision. Preview/public snapshots flatten that content as before. No new envelope, mutation header, ID type or child position field is introduced.

### Release version policy and cache safety

Existing controls keep their original roles. `UI_BUILDER_PUBLIC_CUTOVER_ENABLED` only changes the legacy Home GET selection; the dedicated `/ui-layouts/customer_home` route does not need it.

The implementation adds one optional server policy input, `UI_BUILDER_EXTENSIONS_MIN_APP_VERSION`, exposed as catalog `extensions_min_app_version`. This is deliberately separate: a previously approved ID-only/eight-block version is not evidence that it can render subcategory destinations or array-based banners.

- Leave the extension floor absent until an actual supporting build is approved. Missing/invalid means extension publication and selection are blocked.
- A new-profile extended layout needs `targeting.min_app_version` at least both applicable floors: core `UI_BUILDER_ID_ONLY_MIN_APP_VERSION` and extension floor. A legacy-shaped subcategory action still needs the extension floor.
- General publication also needs `UI_BUILDER_PUBLISH_ENABLED=true`; scheduling additionally needs existing queue configuration and worker acceptance.
- Setting a catalog field in frontend JSON cannot approve a release. This implementation task does not set/decrypt/commit any environment value or guess a release version.
- Validation/release/worker/rollback recheck references and the floor. An extension-disabled rollback fails without activating unsupported historical content.
- Public selection skips incompatible extension snapshots and preserves a compatible fallback. Core layouts with no new action/array keep their prior compatibility.
- The extension floor joins the server's existing cache selection key. Full ordered slide content participates in renderer checksums; changing a slide/order changes the validator without mutating old previews.
- Existing customer ETag/context cache, product hydration identity/locale/warehouse scope and no-store preview rules still apply. Local mocked-cache tests are not deployed Redis acceptance.

### Findings and recovery

| Code/outcome | Meaning | Next action |
| --- | --- | --- |
| `IMAGE_SOURCE_CONFLICT` | Both source properties are present. | Normalize to exactly one, then send a new logical full save. |
| `INVALID_IMAGE_URLS` | Array shape/count violates 1–10. | Correct selections; never truncate silently. |
| `DUPLICATE_IMAGE_URL` | Repeated exact slide URL. | Remove the intended duplicate consciously; preserve remaining order. |
| `INVALID_HTTPS_URL` | A slide is non-string/empty/unsafe. | Select the exact approved public URL; do not retry unchanged bad content. |
| `IMAGE_REQUIRED` | No completed source for preview/release. | Complete the draft selection first. |
| `ASSET_NOT_READY` | A specific URL is not ready registered/recognized catalog media. | Complete/select the asset, save, validate and recreate preview. Findings identify `image_urls[index]`. |
| `INVALID_REFERENCE_ID` | Subcategory action does not contain an ObjectId. | Obtain the picker ID, not a node UUID or category label. |
| `REFERENCE_NOT_PUBLIC` | Destination no longer exists/is unavailable under existing policy. | Re-select/remove it explicitly, save and retry validation. |
| `CLIENT_VERSION_UNSUPPORTED` | One required renderer floor is absent/too low. | Continue draft/preview; wait for approved release policy. |
| Existing revision/retry/state errors | Existing whole-layout protections still apply. | GET/reconcile the current draft and retain the original operation key for exact retries. |

Removing an image reference does not remove the shared asset. A deleted linked product still becomes unavailable in the existing batch response; a subcategory action is not a commerce snapshot. Renderer swiping, pause/play, reduced motion, background lifecycle and RTL behavior require customer/admin implementation, not backend timers.

### Acceptance boundary

Locally tested: 1/2/10-image round-trips; 11/duplicate/unsafe/conflicting sources; each indexed slide's readiness; disabled content; subcategory action owners and malformed/unavailable references; exact manifests; picker tree/filter/pagination; separate storage/release gates; immutable previews/checksums; revisions/replays; versions/cloning/scheduled publication/rollback; compatible fallback and cache-key changes.

Not established by this chapter: an approved release build, deployed catalog/worker/cache behavior, real current assets/accounts, production publishes, physical-device rendering or FCM delivery/sound. The combined response records Video CTA local implementation separately.

## 19. Internal safety fixes and final phase response

Existing builder requests/responses remain unchanged by the audit fixes. An uncertain UI asset save no longer triggers deletion of possibly committed media; reconcile the library before manually retrying a non-idempotent upload. The request ID header now also survives early parser errors. These do not add body fields or required headers.

The [combined FE response](PHASE_BACKEND_PRODUCTION_RESPONSE_AND_INTEGRATION_GUIDE.md) replaces the oversized earlier report and describes the three agreed additions, every new field's origin/reuse, complete preparation flows, internal fixes and remaining release/device acceptance. Final combined local result: 877 passed, zero failed, five external skips.

### 2026-10-16 customer-version configuration

Customer **5.1.9** is owner-confirmed as the first compatible block/carousel/subcategory version; live **5.1.8** lacks support. Both encrypted backend floors are now 5.1.9 on the inspected server. Use a minimum of at least 5.1.9 for extended layouts; the previous unset-floor preparation decision is superseded. Legacy cutover remains false, and no layout was published. See [the publish-blocker response](UI_BUILDER_PUBLISH_BLOCKERS_RESPONSE.md) before reopening/saving the affected draft.
