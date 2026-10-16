# PetYard — Response to the frontend production handoff

**Update 2026-10-16:** the owner confirmed customer 5.1.9 is the first compatible block/carousel/subcategory version and live 5.1.8 lacks support. Both encrypted server version floors are now 5.1.9; legacy Home cutover remains false. This supersedes the earlier unset-version preparation policy below, not the remaining device/publication acceptance requirements. See [the publish-blocker response](UI_BUILDER_PUBLISH_BLOCKERS_RESPONSE.md) for actual draft/runtime evidence and operator steps. No layout was published by that correction.

Date: 2026-10-15. Input: `PHASE_BACKEND_PRODUCTION_HANDOFF.md`, dated 2026-10-14.

This is the combined backend response for Products, UI Builder, Videos and notifications. It replaces the oversized earlier report at this path. It explains the changes and integration steps without copying the existing API manuals, complete catalog or source patches.

## 1. Read this first

The frontend's existing valid requests, required headers, routes and success response envelopes remain in place. The internal audit fixes below do not require a new frontend integration. Requests made by a revoked staff account can now be rejected at the database write boundary; that is an authorization correction, not a new request contract.

The three agreed additions do require frontend implementation:

1. UI Builder actions targeting a subcategory.
2. Multiple ordered banner images inside an image block.
3. Ordered product links on general YouTube Videos and Reels.

Product image corrections follow the frontend handoff's stated combined-gallery indexing. A client using upload-only indexes must not assume that meaning; the supplied handoff says this frontend already uses the combined gallery.

**Implementation is local, not a deployment claim.** The inspected starting commit was `08ac5b9`. Local changes after it do not establish what the live API currently serves. This work does not authorize deployment, production publication, live notifications or configuration changes.

No supporting customer build has been approved for blocks, subcategory actions and carousels together. Save and authorized preview are available preparation paths; extended customer publication must remain gated.

### Reading map

| Need | Read |
| --- | --- |
| Understand the internal fixes | Section 2 |
| Integrate subcategories, carousels and their draft/preview flow | Sections 4–7 |
| Integrate Video product links | Sections 8–9 |
| Understand corrected Product images | Section 10 |
| Notification and upload limits | Sections 11–12 |
| Errors, retries, release and evidence | Sections 13–15 |
| Every unchanged UI route and original field | [UI Builder integration guide](UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md) |
| Original ID-only product/block integration | [ID-only integration guide](UI_BUILDER_ID_ONLY_INTEGRATION_GUIDE.md) |
| Every existing Video route, grant and response | [Videos frontend handoff](VIDEOS_FRONTEND_HANDOFF.md) |

Examples below use illustrative IDs and media URLs, not approved test records. Replace them with values returned by the selected environment. Examples explicitly marked **response excerpt** omit unchanged fields; do not treat them as complete DTOs.

## 2. Audit corrections: what changed, and what FE must do

| Item | Backend change | Frontend impact |
| --- | --- | --- |
| Editorial permission revocation during a request | Request-driven editorial persistence carries the internal authenticated actor into a conditional User write in the same Mongo transaction as the Video mutation. A real internal version increment makes concurrent account/role/control changes conflict with the transaction. | No new body field or header. Keep existing authorization error handling. An account disabled while verification is running must not finish that edit successfully. |
| Early parser failures had no request ID | Request-ID middleware now runs before raw webhook, Product batch and normal body parsers. It does not parse or rewrite webhook bytes. | Existing `X-Request-Id` is now available on early parser errors too. Save it with a failed operation's diagnostics; do not send it as an authorization or idempotency key. |
| Repeated new-order events could create repeated alerts | New-order alerts use the existing durable notification outbox with a stable key for the event, order and recipient. The same order/recipient is deduplicated; different orders remain separate. | Existing inbox and push contracts remain. No client dedupe key is requested. Delivery now depends on the existing outbox worker running. |
| Staff could become ineligible before notification delivery | New-order selection filters actual eligible accounts. Before sending known order or YouTube player-error staff alerts, the outbox worker rechecks current account, role/control and applicable warehouse membership. | No new registration or inbox fields. A historical notification does not grant access; still refetch the protected destination. |
| Lost UI asset-save acknowledgement could delete committed media | A database outcome that might have committed no longer triggers media deletion. Definite pre-save validation/cast failure can clean up; post-save serialization failure cannot remove the uploaded media. | Same multipart upload and response. After an uncertain upload result, reconcile the asset library before retrying. Upload is not newly idempotent. |
| Original video-container inspection | **Accepted limitation, not claimed fixed.** The owner chose to retain direct Bunny uploads. Existing manifest, fixed upload-length and processing-readiness checks remain. Our backend does not receive the original file bytes. | No upload-flow change. Do not describe a successful MP4/MOV manifest as proof that original container bytes were independently inspected by our backend. |

### Important boundaries

- The editorial fence covers request-driven editorial create/edit/review/publication, cover attachment, positions, permanent removal and manual replacement/pending cancellation paths wired through that persistence. It is not a claim that every write in every Petyard domain was redesigned.
- Automatic Reel work retains the already-established authorization policy captured when the automatic change was created. It does not reinterpret later creator roles as a new automatic publication policy.
- The User version touched by the fence is internal. It is not a new FE revision field, does not require a new token and is not returned as a new contract field.
- A simultaneous User array save may encounter the existing Mongoose version-conflict behavior because this fence increments `__v`. This is an internal concurrency consideration, not a new FE field. Real Mongo conflict/retry acceptance remains required.
- Deduplication prevents repeated application events from creating separate outbox/inbox records. It cannot guarantee exactly-once physical push delivery if Firebase accepted a send but its acknowledgement was lost.
- Notification eligibility is rechecked immediately before dispatch. Account changes after dispatch cannot recall a push already handed to a provider.
- Keeping media on an ambiguous save can leave an orphan if the database really did not commit. This intentionally avoids deleting media that a committed asset may reference. No automatic orphan-deletion campaign was added.

## 3. Response to the FE checklist

“Local” means source and automated tests with controlled adapters, not deployed or physical-device acceptance.

| FE section | Response |
| --- | --- |
| 1 — scope | Existing domain services reused. No replacement commerce service, translation service or speculative endpoints. |
| 2 — acceptance inputs | Still needs operator-confirmed environment/revision, approved records/actions, staff accounts, signed builds, owners and rollback target. API origin alone is not staging proof. |
| 3 — Product images | Merge preservation, exact removal IDs, combined indexes, main-only changes, final-gallery limits, MIME/content checks and safe SVG handling corrected locally. Type/SKU limitations are explicit in section 10. Historical connection-closed incidents still need actual server/provider logs. |
| 4 — UI lifecycle | Existing whole-layout draft, validation, frozen preview, schedule, history and rollback retained. No per-section draft API introduced. |
| 5 — blocks/localization | All eight existing block types retained; authored IDs/order and supported `{en, ar}` values preserved. Runtime validation and catalog updated together. |
| 6 — subcategories/carousels | Implemented locally across schemas, reference checks, draft/preview, publication compatibility, history/schedule/rollback and public selection. Extended publication remains release-gated. |
| 7 — manifest/batch | Existing explicit product-ID manifest and `/products/batch` retained. Subcategory IDs do not become product IDs. |
| 8 — assets/selection | Existing one-step multipart path and narrow JPEG/PNG/WebP policy retained. Every carousel slide is checked. No legacy cutover was enabled. |
| 9 — Videos | Existing upload/recovery/processing/review/customer contracts retained. Editorial revocation race corrected locally. Original-container limitation accepted; real provider/mobile acceptance remains separate. |
| 10 — Video CTA | Exact field `productIds`; human-approved maximum 50; existing create/edit/public DTOs extended. See sections 8–9. |
| 11 — notifications | New-order outbox dedupe and current staff eligibility corrected. Existing order Android/APNs options preserved through the actual sender construction. Physical sounds remain unverified here. |
| 12 — safety/errors | Existing envelopes preserved. Early parser request IDs and uncertain asset-save safety corrected. No global API schema replacement. |
| 13 — joint acceptance | Local verification is listed in section 15. Deployed provider/worker/client/device acceptance is not marked complete. |
| 14 — responsibilities | Local Product drafts and reusable section templates stay frontend-owned. No backend carousel timers, alarm UI, menu fallback or direct AI translation service added. Parked legacy/Collections services were not removed. |
| 15 — deliverables | This response, updated existing guides, local Videos collection and offline catalog preparation artifact. Shared Postman/live catalog updates are not implied. |

## 4. Before sending the new UI content

Use a superAdmin access token for builder administration. Other admin controls do not grant access to the builder.

1. Fetch `GET /api/v1/admin/ui-builder/catalog` from the environment FE will actually use.
2. Read its supported schema, action types, limits and capabilities. Do not override false server capabilities with frontend build flags.
3. Prepare entity and asset selections through existing routes.
4. Create or open one whole-layout draft.
5. Save the complete layout snapshot with the normal concurrency protection.
6. Validate, then create a frozen preview for that saved revision.
7. Implement and verify the customer renderer before requesting publication approval.

### Relevant catalog fields

These fields come from the server. They are not writable draft fields.

| Field | Meaning and use |
| --- | --- |
| `schema_version` | Existing layout schema version. Remains 1; do not invent a new wire version for these additions. |
| `product_reference_formats` | Must advertise `id_only_v1` before authoring that content profile against this deployment. |
| `capabilities.product_id_draft_storage` | Server can store the ID-only draft format. Not publication approval. |
| `capabilities.component_tree_draft_storage` | Server can store composed block trees. Not customer-renderer proof. |
| `capabilities.product_id_references` / `component_tree` | Existing release capabilities, separate from draft storage. |
| `capabilities.subcategory_actions_draft_storage` | Server accepts the new typed action in drafts. |
| `capabilities.subcategory_actions` | Current server policy permits release of subcategory actions. |
| `capabilities.banner_carousel_draft_storage` | Server accepts array-based image sources in drafts. |
| `capabilities.banner_carousel` | Current server policy permits release of carousels. |
| `capabilities.publish_now` / `scheduled_publish` | Actual configured publication/scheduling support; route existence alone is insufficient. |
| `limits.max_banner_images` | 10. Apply before upload/selection, but backend remains authoritative. |
| `id_only_min_app_version` | Approved core ID-only/block renderer floor, or null when unconfigured. |
| `extensions_min_app_version` | Separate approved subcategory/carousel renderer floor, or null when unconfigured. |
| Published block/action schemas | Allowed property names/enums and shapes. Unknown props are not silently retained. |

A full sanitized **local preparation artifact**, not a live response, is available in [UI_BUILDER_CATALOG_LOCAL_PREPARATION.json](UI_BUILDER_CATALOG_LOCAL_PREPARATION.json). Its provenance `meta.source` describes the artifact, not a new server field. Fetch the real catalog before integration testing.

## 5. Addition A — subcategory destinations

### Step A1: select a real subcategory

```http
GET /api/v1/subcategories
Authorization: Bearer <token-if-using-authenticated-catalog>
```

The response has `data` containing a nested tree. Walk `children` recursively; do not assume the top level contains every selection. This route is not the paginated Product list.

Existing filters:

- `category=<ObjectId>` selects that category's tree.
- `subcategory=<ObjectId>` selects that parent's children and descendants, not the parent itself.
- `q=<text>` searches names while retaining matching branches.
- `page`/`limit` do not paginate this tree. Large-tree completeness/performance still needs acceptance against actual catalog data.

Save the selected node's **`id`** and display fields locally. Do not use its slug, category ID, localized name or a block UUID as the destination.

### Step A2: author the typed action

```json
{
  "type": "subcategory",
  "value": "68cf1234567890abcdef1238"
}
```

| Field | Origin | Meaning / reuse |
| --- | --- | --- |
| `type` | Catalog action enum plus admin's selection | Exact literal `subcategory`. Tells the renderer which browse destination to open. |
| `value` | Selected tree node's `id` | Actual 24-hex subcategory ObjectId, canonicalized by backend. Store with the action and reuse when navigating/filtering products. |

Use that action in an existing supported promo/section destination, a manual catalog item or a button. It does **not** add new fixed bottom-navigation destinations. Navigation still uses home/videos/favorites/orders/profile. The existing optional chatbot preference stays at `content.floating_action_button`, alongside navigation; it is stored in drafts/history but omitted from current public/preview renderer payloads.

Backend reference checks require a real subcategory. The model has no subcategory active flag; no new eligibility policy was invented. A missing record produces a finding at its action path, not a product lookup or silent redirect.

### Step A3: browse its products when needed

```http
GET /api/v1/products/admin?subcategory=68cf1234567890abcdef1238&page=1&limit=20&isActive=true
Authorization: Bearer <products-authorized-token>
```

The existing Product response retains `totalResults`, `totalPages`, `page`, `results` and `data`. Iterate its actual pages. A single subcategory filter includes descendants. Existing category/brand filters still work and combine with it. Builder access alone does not bypass Product route permissions.

Two different choices must remain separate:

- **Browse card:** store the subcategory action; it opens a product listing at runtime.
- **Explicit product selection:** select real Product IDs from results; store their normal placements and include those IDs in the layout manifest.

A browse card never expands its entire subcategory into `content.product_ids`. Do not manufacture stock, price or a Product DTO for the subcategory.

Subcategory artwork can be reused only through its exact approved stored public URL under existing media-reference checks. A transformed catalog delivery URL is not automatically a registered builder asset.

## 6. Addition B — ordered banner/carousel images

This extends **image block props**, not the Product gallery and not a new upload protocol.

### Step B1: upload or select each image first

```http
POST /api/v1/admin/ui-builder/assets
Authorization: Bearer <super-admin-token>
Content-Type: multipart/form-data; boundary=<generated-by-client>
```

Multipart fields:

| Field | Send | Meaning |
| --- | --- | --- |
| `image` | One binary local file | New JPEG/PNG/WebP, at most 5 MiB. Do not send a URL or base64 string as the file. |
| `usage` | `promo` or `dynamic_item` | Existing asset usage classification. Select the appropriate existing usage; do not invent `carousel` or `slide`. |

Let the HTTP client generate the multipart boundary. Existing UI decoding also enforces dimensions <=8000 on each axis and <=25 million pixels, plus matching MIME and decodable content. The six-format Product gallery policy does not widen this endpoint.

Example complete success envelope; dimensions, size and times are illustrative:

```json
{
  "data": {
    "id": "bbbf6290-2607-42a8-8b5a-6cecc7e1c6d4",
    "status": "ready",
    "usage": "promo",
    "url": "https://media.petyardstores.com/ui-builder/offer-one.webp",
    "width": 1600,
    "height": 900,
    "byte_size": 120000,
    "created_at": "2026-10-15T10:00:00.000Z"
  },
  "meta": {"request_id": "8f8e86cf-7077-4e35-8416-60256da1ae10"}
}
```

Save the returned descriptor locally: ID for library identity, URL for authored content, readiness/usage/dimensions for the editor. Repeat for each new slide or choose existing ready records from `GET /api/v1/admin/ui-builder/assets?limit=30`. Follow its returned cursor to reach more records.

### Step B2: choose exactly one source property

Existing single-image block props remain valid:

```json
{"image_url":"https://media.petyardstores.com/ui-builder/offer-one.webp"}
```

Multiple images use:

```json
{
  "image_urls": [
    "https://media.petyardstores.com/ui-builder/offer-one.webp",
    "https://media.petyardstores.com/ui-builder/offer-two.webp"
  ],
  "aspect_ratio": "16:9",
  "fit": "cover",
  "border_radius": "md",
  "alt_text": {"en":"Pet offers","ar":"عروض للحيوانات الأليفة"}
}
```

| Field | Meaning and allowed values |
| --- | --- |
| `image_url` | One exact approved public URL. Omit `image_urls` entirely. |
| `image_urls` | Ordered array of 1–10 distinct nonempty approved public HTTPS URL strings. Omit `image_url` entirely. No asset DTOs, UUIDs, local paths or signed preview URLs. |
| `aspect_ratio` | Existing optional `16:9`, `4:3` or `1:1` renderer hint. |
| `fit` | Existing optional `cover` or `contain`. |
| `border_radius` | Existing optional `none`, `sm`, `md` or `lg`. |
| `alt_text` | Existing optional literal or `{en,ar}` localized text; maximum 120 UTF-16 code units per language. Shared block-level text, not a new per-slide object. |

FE should continue emitting `image_url` for one image and `image_urls` for multiple images. Array form with one URL is accepted. Backend preserves order; it does not reduce the array to its first image.

### Rules and edge cases

- Both properties together are invalid, including one set to null.
- Empty arrays, duplicates, non-string members, unsafe URLs and more than ten slides are rejected, not sorted/truncated/deduplicated.
- An unfinished draft may omit both sources. Completed preview and publication require a source.
- Every slide must be currently registered/recognized and ready under existing usage/media rules. Disabled sections do not bypass checks.
- Removing a slide/reference does not delete a shared asset.
- Reordering changes the saved snapshot/checksum. Existing previews and published versions remain immutable.
- No auto-scroll interval, per-slide action, custom CSS or playback timer field was added. Swiping, pause/play, lifecycle, reduced motion and RTL remain renderer responsibilities.

## 7. Complete UI preparation sequence

### Step 1: create or reopen a whole-layout draft

```http
POST /api/v1/admin/home-layouts/drafts
Authorization: Bearer <super-admin-token>
Content-Type: application/json
```

```json
{"layout_key":"customer_home","name":"Subcategory offers","source":{"type":"blank"}}
```

Existing alternative: `source:{"type":"published","version_id":"<actual-version-uuid>"}` clones an immutable version into a draft. Save the returned `data.id`, `data.revision`, acknowledged `content` and `targeting`. A new blank draft starts at revision 1. Read it later with `GET /admin/home-layouts/drafts/:id`.

Drafts belong to the entire layout. A local reusable section is inserted as an independent copy; it is not saved through a separate backend section lifecycle. Give copied section/node/item instances fresh UUIDs, while keeping the intended Product/subcategory IDs.

### Step 2: save the complete snapshot

```http
PATCH /api/v1/admin/home-layouts/drafts/<actual-draft-uuid>
Authorization: Bearer <super-admin-token>
Content-Type: application/json
If-Match: "1"
X-Client-Mutation-Id: 72296096-c6d1-43d3-bb70-c16505332b2d
```

The body below combines both additions and contains no explicit Product reference, so its manifest is empty. Replace its illustrative URLs and subcategory ID with real selections.

```json
{
  "name":"Subcategory offers",
  "change_note":"Prepare two slides and a browse button",
  "targeting":{
    "platforms":[],"locales":[],"country_codes":[],"location_ids":[],
    "min_app_version":null,"max_app_version":null,"audience":"all","priority":0
  },
  "content":{
    "product_reference_format":"id_only_v1",
    "product_ids":[],
    "sections":[{
      "id":"3ab92c12-414f-47bc-a801-ce63d77fe6e2",
      "section_type":"composed_section",
      "position":0,
      "data":{
        "enabled":true,
        "root":{
          "id":"04f46e28-6720-4e10-9aa5-0a6af01ef90c",
          "type":"column","props":{},
          "children":[{
            "id":"0b924497-0954-475d-9d51-f0d33f13b604",
            "type":"image",
            "props":{
              "image_urls":[
                "https://media.petyardstores.com/ui-builder/offer-one.webp",
                "https://media.petyardstores.com/ui-builder/offer-two.webp"
              ],
              "aspect_ratio":"16:9","fit":"cover","border_radius":"md",
              "alt_text":{"en":"Pet offers","ar":"عروض للحيوانات الأليفة"}
            }
          },{
            "id":"bc2183db-841d-4104-96c2-28c74a1b890b",
            "type":"button",
            "props":{
              "label":{"en":"Browse treats","ar":"تصفح المكافآت"},
              "action":{"type":"subcategory","value":"68cf1234567890abcdef1238"}
            }
          }]
        }
      }
    }],
    "navigation":{"items":[
      {"key":"home","label_key":"home","icon_key":"home","destination":"home","order":0,"enabled":true}
    ]}
  }
}
```

| Field/header | Where it comes from and how to reuse it |
| --- | --- |
| Path draft ID | `data.id` from create/list/detail. Layout/draft/version/preview IDs are distinct; never interchange them. |
| `If-Match` | Latest acknowledged draft `revision`, enclosed in quotes. Required for save. A stale value must not overwrite another save. |
| `X-Client-Mutation-Id` | FE-generated UUID for that exact logical save. Keep with its original body/revision until outcome is known. Existing server permits omission; supplying it enables safe same-save replay. A changed save gets a new UUID. |
| `name` | Admin editor label, <=120 characters. It is not the customer section heading. |
| `change_note` | Optional editorial note, not rendered customer text. |
| `targeting` | Full selection policy: allowed platforms/locales/countries/locations, version bounds, audience and priority. Empty selection arrays mean unrestricted within that dimension. Do not guess approved release floors. |
| `product_reference_format` | Exact `id_only_v1` for the new explicit-reference profile. |
| `product_ids` | Required ordered unique manifest of all explicit Product references, including hidden content and Product actions. Empty here because the example only browses a subcategory. |
| Section/node `id` | FE-generated UUID identifying authored instances. Keep stable while editing that instance. Not database entity IDs. |
| `section_type` / `position` | Existing section contract and zero-based layout ordering. Nested children use array order, not extra position properties. |
| `data.enabled` | Existing composed-section visibility toggle. It does not make invalid references acceptable. |
| `root` | Column node; row/column nodes require `children`. Leaf nodes omit `children`. |
| `navigation` | Complete desired fixed-destination navigation configuration. Preserve other intended items when editing an existing layout. Preserve a desired stored chatbot preference separately at `content.floating_action_button`; do not put it inside navigation. |

Save responds HTTP 200 with the full draft under `data` and normal `meta.request_id`. It includes server identity/status/schema/revision, targeting/content, source-version link, notes, schedule state and timestamps. Store the returned revision/content as the acknowledged baseline; do not write response metadata back into the next PATCH.

The snapshot replaces authored layout content; it is not a JSON Patch or “append these children” request. A minimal example must not accidentally erase unrelated existing sections/navigation when applied to a real draft.

### Step 3: validate the saved draft

```http
POST /api/v1/admin/home-layouts/drafts/<draft-id>/validate
Authorization: Bearer <super-admin-token>
Content-Type: application/json
```

```json
{}
```

Response fields under `data`: `valid`, `draft_id`, `revision`, `errors`, `warnings`, `validated_at`. Each finding identifies its path/code/message. Validation checks release readiness as well as content. A missing compatible-version floor can make validation report a release error even though the draft saved correctly.

Do not remove the tree or hide a finding merely to obtain `valid:true`. Fix bad references/content. A renderer-release finding needs release approval, not fake frontend capabilities.

### Step 4: issue a preview of the acknowledged revision

```http
POST /api/v1/admin/home-layouts/drafts/<draft-id>/preview
Authorization: Bearer <super-admin-token>
Content-Type: application/json
```

```json
{"revision":2,"locale":"en","platform":"android","expires_in_seconds":1800}
```

Use the actual saved revision instead of assuming 2. Lifetime is 60–3600 seconds, default 1800. Existing optional `device_profile` and `location_id` are preview context, not new authored layout fields.

HTTP 201 example:

```json
{
  "data":{
    "preview_id":"c43ddc31-8f27-49ab-8858-d7db05c80861",
    "token":"<private-issued-token>",
    "expires_at":"2026-10-15T10:30:00Z",
    "revision":2,
    "preview_url":"/api/v1/home-layout/preview?token=<private-issued-token>"
  },
  "meta":{"request_id":"8f8e86cf-7077-4e35-8416-60256da1ae10"}
}
```

Save the preview ID for revocation, and keep the token/URL private until expiry. Resolve the relative URL against the API **origin**, not an already suffixed `/api/v1/` base; do not produce `/api/v1/api/v1/...`.

Read the issued URL. Its response uses public-style flattened `data`: layout/version metadata, checksum, sections/navigation and profile/manifest, not `data.content`. Preview `version_id`, `version_number` and `published_at` are null; they do not identify a real release. `meta` includes `preview:true`, draft/revision, requested context and request ID.

Prepared new-profile/extended drafts can be previewed before approving a customer release. This bypasses release-floor/overlap checks for preparation, not content/reference/media checks. Possession of the issued token grants access to that frozen preview; protect it accordingly.

Editing the draft does not update an old preview. Save again, keep the new revision and issue another preview. Revoke an obsolete preview using `DELETE /api/v1/admin/home-layouts/previews/:previewId` (204). Unknown token returns 404; expired/revoked token returns 410.

### Step 5: release later, after approval

Do **not** perform this step merely because preview succeeds. Once approved, the existing publish request remains:

```http
POST /api/v1/admin/home-layouts/drafts/<draft-id>/publish
Authorization: Bearer <super-admin-token>
Content-Type: application/json
Idempotency-Key: <uuid-for-this-publication>
```

```json
{"revision":2,"mode":"now","change_note":"Approved customer release"}
```

For scheduling, use `mode:"schedule"` and `scheduled_for` as a valid approved future UTC timestamp ending in `Z`. Preserve the exact key/body on an uncertain outcome; a different intended publication uses a new key.

Existing validation, overlap, state and reference checks still apply. The schedule worker rechecks eligibility at execution. History/version responses are immutable snapshots; rollback creates a new release after current compatibility/reference checks, not an in-place edit of history. Cancel scheduling through the existing cancel-schedule route before editing a scheduled draft.

### Existing limits retained

30 sections; 5 navigation items; block depth 6 including root; 50 nodes/section; 12 children/container; 20 catalog-list items; 50 unique explicit Product IDs; renderer JSON maximum 262144 UTF-8 bytes. Existing title/text/enums and built-in repeatability rules remain; the catalog and original guide describe them.

Manifest traversal remains section position, owner action before its items, then block preorder. Repeated Products may appear through different placement UUIDs but occur once in the manifest. Do not sort the manifest or include category/brand/subcategory IDs. Product placements remain only `id` and `product_id`, never copied commerce fields.

## 8. Addition C — products linked to general Videos

### Confirmed contract

Exact field: **`productIds`**. Maximum: **50**, approved by the owner. This is deliberately different from layout `content.product_ids`. No new endpoint, custom CTA label field, schema-version input or mandatory revision header was introduced.

| Surface | Behavior |
| --- | --- |
| POST `/api/v1/videos/admin` | Optional ordered `productIds`; omission creates no links (`[]`). Existing metadata/kind remain required. |
| PATCH `/api/v1/videos/admin/:id` | Omit to preserve; `[]` to clear; supplied array replaces the complete ordered selection. |
| Admin detail/list | Active `productIds`; where a proposal exists, independent `pendingChange.content.productIds`. |
| Public YouTube/Reel lists/feed/detail/saved DTOs | Only active published links. No pending proposal data. |
| Older stored general videos | Returned links default to `[]`, without rewriting historical records. Playback does not require a CTA. |
| Separate Product Videos | Existing singular `productId`/`productHref` flow remains; do not send general `productIds` to its upload/update endpoints. |

Validation: array with 0–50 unique eligible Product ObjectId strings. IDs canonicalize to lowercase and retain selection order. Case-insensitive duplicates, null, strings instead of arrays, non-string members, malformed IDs, missing/inactive Products and overflow are rejected. Nothing is silently sorted, dropped or truncated.

Eligibility reuses existing `isActive:true` catalog policy, not a new “must currently have stock” rule. Backend rechecks at authoring and relevant submit/approval/publication/application points. Current Product state is resolved again when customers hydrate links.

### Step C1: select Products and save IDs

Use the existing authorized paginated Product picker. Save each real Product `id` in the user's chosen order. UI details may be held locally for the picker; send only IDs as this field.

### Step C2: create a general YouTube Video

```http
POST /api/v1/videos/admin
Authorization: Bearer <videos-authorized-admin-or-super-admin-token>
Content-Type: application/json
```

```json
{
  "kind":"youtube",
  "youtubeUrl":"https://youtu.be/dQw4w9WgXcQ",
  "title_en":"Pet care guide",
  "title_ar":"دليل العناية بالحيوانات الأليفة",
  "description_en":"Products used in this guide.",
  "description_ar":"المنتجات المستخدمة في هذا الدليل.",
  "productIds":["68cf1234567890abcdef1235","68cf1234567890abcdef1234"]
}
```

The URL must pass the existing server availability check; the example is not a promise that this video is eligible in the test environment. Existing titles trim and allow up to 160 UTF-16 code units; optional descriptions up to 2000. Supported HTTPS YouTube watch/shorts/youtu.be inputs normalize to canonical video identity.

HTTP 201 **response excerpt** for an admin-created item:

```json
{
  "data":{
    "id":"68cf1234567890abcdef1240",
    "kind":"youtube",
    "status":"draft",
    "youtubeId":"dQw4w9WgXcQ",
    "productIds":["68cf1234567890abcdef1235","68cf1234567890abcdef1234"],
    "pendingChange":null
  }
}
```

**Important existing behavior:** superAdmin YouTube create publishes immediately after successful validation. An ordinary Videos-authorized admin creates a draft and follows submit → superAdmin approval → publication. Do not assume every create is draft-only. Approval and publication remain distinct for reviewed drafts.

Save the returned Video `id` for detail/edit/review; `revision` wherever an existing operation needs it; active links and any separate pending content for the editor. Keep the returned full DTO rather than reconstructing it from this excerpt.

### Step C3: update, preserve or clear

```http
PATCH /api/v1/videos/admin/68cf1234567890abcdef1240
Authorization: Bearer <videos-authorized-admin-or-super-admin-token>
Content-Type: application/json
```

Replace the selection:

```json
{"productIds":["68cf1234567890abcdef1234"]}
```

Clear it:

```json
{"productIds":[]}
```

Keep it while editing metadata:

```json
{"title_en":"Updated pet care guide"}
```

`null` does not mean clear. It returns 422 with the existing Video error envelope:

```json
{
  "status":"fail",
  "error":[{"code":"VIDEO_INVALID_PRODUCT_IDS","field":"productIds"}],
  "message":"<safe validation message>"
}
```

Individual bad members may use an indexed path such as `productIds[0]`. Keep the existing envelope decoder; do not add a new global error format. Other unchanged errors retain their existing fields/codes.

### Step C4: preserve active versus proposed links

When an ordinary admin edits a reviewed/published item, its published fields stay active and a proposal holds the new selection. HTTP 200 **response excerpt**:

```json
{
  "data":{
    "id":"68cf1234567890abcdef1240",
    "status":"published",
    "productIds":["68cf1234567890abcdef1235"],
    "pendingChange":{
      "status":"draft",
      "content":{"productIds":["68cf1234567890abcdef1234"]}
    }
  }
}
```

The customer still sees the active first selection. The admin editor shows the proposal separately. On subsequent proposal edits, omission preserves its proposed links, not an accidental reset to active links.

Submit uses the existing route/state checks. Successful approval applies eligible proposed metadata/links under the existing editorial policy. Reject or cancel does not erase active links. A referenced Product becoming ineligible before application blocks that application; correct the proposal explicitly.

There is no new immutable editorial history API in this phase. Existing reviewer/author/revision/timestamp metadata stays as documented; do not invent a Video versions endpoint.

## 9. Reels, replacements and customer CTA flow

### Reel creation

Create through the same Video route with existing `kind:"reel"`, titles/descriptions and optional `productIds`; omit YouTube fields. Save its returned Video ID, then use the unchanged upload-session flow from the Videos guide.

1. Allocate using the original file manifest and an allocation `Idempotency-Key`.
2. Save session identity, status and scoped upload/grant information privately.
3. Upload directly to the returned provider resource using TUS; resume from authoritative HEAD offsets.
4. Poll the existing status route. Upload 100% is not “ready”; processing must complete and pass backend checks.
5. Follow existing admin review or superAdmin automatic policy. Initial automatic publication also rechecks links after media verification.

Links are metadata, not a second media upload. Do not allocate a new session to repair a Product selection, and do not allocate a new resource merely because an upload acknowledgement was lost.

### Replacement

The existing replacement reserves separate pending media and copies the intended metadata/links. Active media and active `productIds` remain usable while pending upload/processing/review continues. Applicable approval or automatic cutover switches media and links together. Failure/cancellation preserves active media/links. Late/stale callbacks cannot apply an unrelated old generation.

Keep active and pending session/asset IDs separate in local state. Do not overwrite the active player URL with an unfinished replacement. Covers retain the existing dedicated endpoint/pending ownership; links survive cover-only edits.

### Customer hydration and navigation

1. Read a public Video through its existing endpoint.
2. If `productIds` is absent on an older deployment/client record, treat it as no CTA; do not break playback.
3. If nonempty, reuse `POST /api/v1/products/batch` with the IDs.

```json
{"ids":["68cf1234567890abcdef1235","68cf1234567890abcdef1234"]}
```

4. Read available Products under `data` and `meta.unavailable_product_ids`. Product values use the existing complete public detail DTO, not a new Video commerce DTO.
5. Rebuild display order using the authored `productIds`, not an assumed database return order.
6. Open normal Product detail and variant selection. No direct Add-to-cart shortcut was added.
7. If all links become unavailable, hide/disable the shop action honestly while keeping playable media. An out-of-stock available Product is not automatically a missing Product; use its current normal commerce behavior.

The existing batch maximum is 50 IDs, request maximum 2 KiB and response maximum 2 MiB. Supply the existing authentication/guest, warehouse and language context. Do not share cached personalized/warehouse results across users or scopes. Use existing fixed EN/AR CTA localization; custom CTA text is not part of this change.

## 10. Product image response to FE section 3

Existing `PATCH /api/v1/products/:id` remains JSON for metadata-only edits or multipart when adding files. HTTP 200 still returns the saved Product under `data`, including its complete authoritative gallery.

| Field | Source and exact meaning |
| --- | --- |
| `removedImagePublicIds` | Exact `images[].public_id` values from the saved Product. Presence selects merge semantics. `[]` preserves all existing images. Every nonempty ID must belong to this Product. |
| Binary `images` | Only newly selected files, in selection order. Existing image URLs are not reuploaded. |
| `mainImageIndex` | Zero-based index in the final combined gallery: retained old images after removals, then new uploads. Works without new files. Omission/null follows preservation/fallback; non-null out-of-range/fractional indexes reject. |
| `variants[].imageIndex` | Same final-gallery indexing. Explicit null clears; omission preserves an existing surviving association. Removed image associations clear rather than pointing at an unrelated index. |
| Existing variant `_id` | Keep the real variant identity when using the existing complete variant update. This correction does not create a partial-variant PATCH protocol. |
| Returned `images[].public_id`, `url`, `isMain` | Authoritative saved identity, URL, order and main state. Rebuild local indexes from these values after success/reconciliation. |

Multipart empty removals are the text `[]`. Nonempty arrays may use indexed names such as `removedImagePublicIds[0]`. Do not encode empty removals as `[""]`. Let the transport generate its boundary.

Example: A/B/C exist. Send `removedImagePublicIds=[]`, binary D and `mainImageIndex=3`. Result: A/B/C/D once each, D main. Later remove B by its exact public ID: result A/C/D. A later upload E produces A/C/D/E. Main-only selection of C uses index 1 at that point and needs no file.

Final limit is 10 retained-plus-new images after removals, not ten new files on top of a retained gallery. Nonempty galleries have one main image. If the selected main is removed without an explicit replacement, existing first-available fallback applies. An empty gallery is supported with no main; do not supply a non-null index into it.

Clients omitting `removedImagePublicIds` retain the legacy file-upload replacement behavior. FE should keep sending the explicit field for merge edits. The image correction does not alter price/discount/warehouse/stock business rules.

### File types, safety and failure handling

Product gallery accepts JPEG/PNG/JPG alias/GIF/WebP/SVG MIME types from the handoff. Declared MIME is checked against real decoded content; JPEG alias normalizes. Files are bounded to 5 MiB each with dimension/pixel bounds. Unsafe SVG scripts/external references/content are rejected; safe SVG is rasterized through the existing image pipeline. Video covers remain JPEG/PNG/WebP only, with their existing <=5 MiB portrait/orientation constraints.

Product multipart limits are 10 files, 1000 text fields of <=16 KiB each, 1010 parts, 100-byte field names and 100 header pairs. The retained field-plus-file maximum is approximately 65.625 MiB, **not** a promised raw network request/proxy limit. Existing JSON and configured provider timeouts remain separate; deployed proxy/client timeout values need operator confirmation.

Known file-validation failures use structured errors rather than generic 500. A provider failure must not erase the original gallery. On a lost save acknowledgement, GET the Product detail and reconcile before manually retrying; no new Product update idempotency guarantee was added.

### Product type and SKU decision

The owner chose to preserve existing behavior pending agreed migration rules. Explicit PATCH `type` remains rejected. Existing SIMPLE→VARIANT conversion through options/variants remains; therefore “Product type is completely immutable” would be inaccurate. SKU is currently optional, with no unique SKU index. This phase does not silently introduce required/unique SKUs or redesign stock/pricing migration. Agree explicit conversion rules before changing those policies.

## 11. Notifications: what remains the same

Device registration remains `POST /api/v1/notifications/devices/register` with current `token`, supported `platform` and EN/AR `lang`. Keep registering under the current authenticated owner after account/token changes. Never place tokens in this document, layout JSON or ordinary logs.

Inbox routes/methods and caller ownership remain unchanged. Inbox notification ID is not the referenced order/Video ID. Follow the existing action/source IDs and refetch the destination under current authorization.

Order events now enter the existing outbox, then the worker checks eligibility and dispatches. Delivery-time recipients are active, non-deleted/non-banned superAdmins; applicable control-enabled admins; or actual moderators still assigned to that order's warehouse. YouTube player-error alerts require current superAdmin or literal Videos-enabled admin access. Ineligible known staff alerts use existing `RECIPIENT_INVALID` dead-letter handling. Other unrelated notification types keep their existing policy.

Existing order platform settings still reach the actual Firebase message construction:

- Android channel `petyard_notification_channel_v7`, sound `petyard_songe`, high message priority and existing max notification priority/vibration/visibility.
- APNs `aps.sound` exactly `petyardSonge.caf`, priority `10`, push type `alert`, and existing content/mutable flags.
- Existing `order_detail`, `OrderDetailScreen` and real order ID route data. FCM data values remain strings.

Do not apply order-specific custom sound settings to every Video alert as an invented policy. The superAdmin foreground ten-second alarm, dismiss button, bundled native resources, Focus/Silent Mode and terminated-app behavior remain frontend/device acceptance. A fake Firebase assertion proves payload construction, not audible physical delivery.

## 12. Direct upload limitation: agreed explicitly

The owner chose **keep direct uploads and document the original-container limitation** on 2026-10-15.

Existing backend controls include supported MP4/MOV manifest extension/MIME pairing, positive declared size <=250 MiB, backend-created scoped TUS resources with fixed declared Upload-Length, and provider processing readiness. Ready media requires processing status 4, positive duration <=90 seconds, positive dimensions and available encodes. These controls remain; completion alone is not readiness.

They do not mean our backend independently inspected the original uploaded container bytes. A client-provided filename/MIME is not byte evidence; a playable transcoded MP4 is not proof of the original source container; provider aggregate storage size is not original byte length.

Independent original inspection would need an agreed original-retention/inspection path or a different upload architecture. No extra original-storage cost, public original exposure or backend upload proxy was enabled without approval. This item is an accepted documented limitation, not a completed spoofed-container acceptance test.

## 13. Errors and values FE must retain

### New-content findings

| Code | Meaning | Correct next action |
| --- | --- | --- |
| `IMAGE_SOURCE_CONFLICT` | Both image source fields supplied. | Keep exactly one; new logical full save. |
| `INVALID_IMAGE_URLS` | Array shape/count violates 1–10. | Correct selection; never silently truncate. |
| `DUPLICATE_IMAGE_URL` | Exact URL repeated. | Remove intentional duplicate and preserve remaining order. |
| `INVALID_HTTPS_URL` | Invalid/unsafe source. | Select the exact approved public URL. |
| `IMAGE_REQUIRED` | Completed preview/release has no image source. | Finish selection and save before preview. |
| `ASSET_NOT_READY` | An indexed slide is not currently usable. | Select/complete it, save and revalidate. |
| `INVALID_REFERENCE_ID` | Action value is not an ObjectId. | Use actual picker entity ID. |
| `REFERENCE_NOT_PUBLIC` | Destination is unavailable under existing reference rules. | Reselect/remove explicitly; do not substitute another entity type. |
| `CLIENT_VERSION_UNSUPPORTED` | Required renderer floor missing/too low. | Continue supported draft/preview preparation; obtain release approval. |
| `VIDEO_INVALID_PRODUCT_IDS` | Links malformed, duplicated, over limit or ineligible. | Correct supplied array and retry intentionally. |

UI findings stay inside the existing UI error/validation envelope with path/code/message details. Video link errors retain the Video envelope shown earlier. Do not treat every domain as `{success:true,...}` or replace its existing decoder.

Existing status distinctions remain: 400 malformed request/header, 401 missing/invalid authentication, 403 denied/revoked authority, 404 unknown entity, 409 revision/state/replay conflict, 410 expired/revoked UI preview, 422 content/reference failure, 429 throttling, and existing service/provider 5xx cases. A successful validate request can return `valid:false`; inspect its payload, not only HTTP 200.

### Retained-state checklist

| Retain privately / in editor state | Used for |
| --- | --- |
| Latest draft ID/revision/acknowledged snapshot | Next GET/full PATCH, preview and publish. |
| Original logical-save UUID, body and If-Match | Exact save replay after unknown outcome. Changed intent gets a new UUID. |
| Original publish/rollback/allocation/recovery key and body | Existing idempotent retry, not a different operation. |
| Asset ID/ready URL/usage | Library selection and authored image URL. No automatic deletion on unreference. |
| Selected subcategory ID | Typed browse action and product-list filter. |
| Section/node/placement UUIDs | Stable authored instance identity. Fresh copies receive new identities. |
| Exact layout Product manifest | Existing batching/hydration, without non-Product IDs. |
| Preview ID/token/URL/expiry | Private frozen read, expiry handling and revocation. Never public persistence/logging. |
| Version ID/version number/checksum | Release/history identity and existing conditional reads/rollback. Not draft revision. |
| Video ID, active/pending links and applicable revision | Edit/review/current-versus-proposed editor state. |
| Active versus replacement session/asset identity | Correct upload/recovery/status/cancel/preview generation. |
| Current Product detail/gallery/public IDs | Safe image removal and final-index mapping. |
| `X-Request-Id` for a failure | Sanitized support/log correlation, never operation authorization. |

On a stale layout revision, GET/reconcile instead of overwriting. On an idempotent unknown outcome, retain the original key and exact request. For non-idempotent create/upload/update, read/reconcile first; a fresh key does not make an uncertain old operation disappear. Honor existing rate-limit cooldown information rather than blind loops.

## 14. Release controls and compatibility

| Server setting | Purpose | Current decision |
| --- | --- | --- |
| `UI_BUILDER_PUBLISH_ENABLED` | General publication policy. | Do not change without operator approval. |
| `UI_BUILDER_ID_ONLY_MIN_APP_VERSION` | First approved compatible core ID-only/block renderer version. | Must reflect a real approved build, not a guessed number. |
| `UI_BUILDER_EXTENSIONS_MIN_APP_VERSION` | New optional separate strict `x.y.z` floor for subcategory actions/carousels. | Leave unconfigured until a supporting build is approved. Missing/invalid fails closed for extended release. |
| `UI_BUILDER_PUBLIC_CUTOVER_ENABLED` | Switches behavior of legacy Home GET. | Keep legacy compatibility; dedicated customer route does not require this switch. |

New-profile extended layouts must target at least both applicable renderer floors. A legacy-shaped subcategory action still needs the extension floor. Draft storage does not require inventing a minimum version; preparation preview does not approve release.

Customer reads use existing `GET /api/v1/ui-layouts/customer_home` with actual `X-App-Platform`, `X-App-Version`, `X-App-Locale`, location/country and authorization context. Public selection skips incompatible extended snapshots and retains compatible fallback. Old/missing app versions must not receive unsupported trees/carousels.

The full ordered content participates in checksums/ETags. Existing private conditional caching, selection-context variation and no-store previews remain. Product hydration cache must retain identity/warehouse/language scope. Local fake-cache tests are not deployed Redis proof.

No old Home route was removed. Existing `GET /api/v1/home-layout` and its legacy update remain for the current app's static-section ordering. Do not enable legacy cutover just to use `/ui-layouts/customer_home`. No new route was needed for the three additions; the established builder/batch/legacy inventory stays 22 method/path combinations.

## 15. Verification, artifacts and remaining acceptance

### Local evidence

The new regressions reproduced the identified failures before their fixes and exercise real services/repositories/HTTP parsers with controlled external adapters. Final combined run: **882 tests, 877 passed, zero failed, five external opt-in tests skipped**, approximately 8.7 seconds. No real database/provider/device acceptance was enabled.

The first sandbox attempt at the new parser HTTP test failed because loopback access was denied. It passed with permitted loopback access; the complete combined run also used that access. No assertion was removed to make it pass. Existing fixture logs can include expected injected failures; the final test result has no failures.

Additional checks passed:

- Videos collection checker: 53 client routes, 62 requests, 354 response examples, 26 request bodies, 11 analytics event types, zero errors.
- Videos guide checker after its audit note update: 98 local links, 23 JSON examples, 117 headings, zero missing frontend codes and zero errors.
- This replacement response: 18 JSON examples parsed; its full layout example passes draft and completed-content structural validation, its targeting and YouTube-create input pass current validators, and all nine local document links/anchors resolve. Illustrative media/entity references still need real approved selections.
- Syntax checks passed for all 60 changed/new JavaScript files; tracked diffs passed whitespace checks.
- Independent source review found no actionable issue in the scoped editorial authority, notification, asset-cleanup and parser changes. It did not certify real Mongo, provider or physical-device behavior.

Areas covered: Product gallery/main/variant preservation and file safety; UI extended schemas/reference traversal/whole-layout lifecycle/preview/replay/release selection; ordered Video links/proposal privacy/eligibility/replacement; editorial revocation persistence; outbox dedupe/current recipients/sound construction; ambiguous UI asset saves; request IDs on malformed/oversized bodies and exact raw webhook preservation.

### Delivery artifacts

- [UI Builder integration guide, including chapter 29](UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md#29-subcategories-and-banner-carousels-october-production-handoff).
- [ID-only guide, including section 18](UI_BUILDER_ID_ONLY_INTEGRATION_GUIDE.md#18-subcategories-and-banner-carousels-october-production-handoff).
- [Videos frontend handoff](VIDEOS_FRONTEND_HANDOFF.md), including linked-product fields and examples.
- [Local Videos Postman collection](postman/Videos.postman_collection.json). Existing create/edit examples updated; a shared Postman workspace update is not claimed.
- [Full local preparation catalog](UI_BUILDER_CATALOG_LOCAL_PREPARATION.json). Not deployed catalog evidence.

Earlier per-module response files remain historical context; this combined response supersedes their old “audit findings remain open” addenda. It does not turn historical VPS reports into fresh deployment verification.

### Before calling the phase production-ready

1. Operator confirms deployed revision and actual sanitized catalog, environment, staff accounts, approved Products/assets/layouts/Videos, actions and rollback target.
2. Exercise deployed JSON/multipart/provider paths, request IDs and unknown-outcome reconciliation on approved records.
3. Verify real Mongo transaction conflicts, outbox worker delivery/retry, queue/cache behavior and no duplicate inbox event under actual service processes.
4. Run real TUS upload/resume/expired-grant recovery, processing, replacement/cancel/late-event and playback scenarios. Retain the agreed original-container limitation honestly.
5. Admin implements the new picker/model fields; customer implements subcategory navigation, ordered carousel rendering and live Video Product CTA hydration.
6. Check EN/AR/RTL, unavailable Products/assets, copied local templates, variants, rendering lifecycle and old-client fallback using exact signed builds.
7. Test notifications on physical Android/iOS in foreground/background/locked/terminated states, current-device ownership and revoked access, including actual sound resources.
8. Approve renderer floors and controlled activation only after joint acceptance. A Publish success, FCM receipt, local passing suite or callback 202 alone is not this approval.

No environment edits, dependency installation, live data/provider mutation, shared collection update, commit/push or deployment is implied by this report.
