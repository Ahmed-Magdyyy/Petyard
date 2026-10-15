# PetYard — October FE backend handoff response

Checked: 2026-10-15, Africa/Cairo. Source: the complete 619-line `PHASE_BACKEND_PRODUCTION_HANDOFF.md` dated 2026-10-14.

This report records the UI Builder/Product phase and its earlier verification. The current combined FE response is [PHASE_BACKEND_PRODUCTION_RESPONSE_AND_INTEGRATION_GUIDE.md](PHASE_BACKEND_PRODUCTION_RESPONSE_AND_INTEGRATION_GUIDE.md). Read that response for the final audit fixes, integration sequence and acceptance boundaries; it supersedes historical in-progress/open-finding labels in this phase report.

Final audit follow-up: editorial persistence authorization, early-parser request IDs, new-order outbox deduplication/current-recipient checks and UI asset ambiguous-save cleanup are now corrected locally. The owner explicitly retained direct uploads and accepted the documented original-video-container inspection limitation. Combined result: 877 passed, 0 failed, 5 external skips. These are local results, not deployment/device acceptance.

## 1. Evidence and authorization boundary

The starting local commit was `08ac5b9`. This task's UI Builder and Product changes are local, uncommitted, and not deployed. The work did not modify or decrypt `.env`, start production workers, create live records/media/previews, send Firebase notifications, install packages, commit/push, or enable a release.

The newer Videos continuation contains a human-supplied VPS report: `08ac5b9` was pulled, seven PM2 processes remained online, seven actual Bunny callbacks returned 202, and approved test-video deletion was confirmed with GET 404. That is historical reported deployment evidence, not a fresh server check performed in this task, and it does not prove full application playback or notification/device acceptance.

The FE configured origin `https://api.petyardstores.com/api/v1/` is not proof of an isolated staging environment. No approved current staging accounts, record scopes or compatible signed customer build were supplied here.

Confirmed human decisions:

- No approved customer version supports blocks, subcategory actions and carousels together yet. Extended publication remains gated; prepare drafts/previews only.
- General Reel/YouTube `productIds` may contain at most 50 linked products. The Videos chat received this approval.
- Product image work is authorized in this chat.
- Keep existing Product conversion behavior; define migration rules before changing it. Do not claim product type is fully immutable.

## 2. Checklist disposition

The labels below have a precise scope. “Implemented and tested” means local source/tests, not production acceptance. “Verified existing” identifies the code path and any local tests, not a live server observation.

| FE section/group | Status | Evidence or remaining work |
| --- | --- | --- |
| 1: phase ownership and additive scope | Verified existing / followed | Existing services and layers reused; no new route or translation service. |
| 2: approved live environment/accounts/actions/builds | Blocked | Operator must supply current environment/revision, approved records, accounts, preview capability, build identities, owners and rollback scope. |
| 3: image merge/main/variant indexing | Implemented and tested | Actual local JSON and multipart routes plus service regressions; details below. No real provider upload performed. |
| 3: file types/real bytes/SVG safety | Implemented and tested | Declared MIME compared with decoded format; byte/dimension/pixel bounds, safe static SVG rasterization and GIF decode tests. |
| 3: prior connection-closed/provider incidents | Not run | Need sanitized request IDs and actual server/provider logs. Local failure injection is not diagnosis of an unidentified production incident. |
| 3: type conversion/SKU policy | Verified existing; migration decision still required | Explicit `type` rejected, existing implicit SIMPLE→VARIANT retained by human choice. SKU currently optional, without a unique SKU index. No new conversion, uniqueness or commercial rules invented. |
| 4: draft/preview/publication lifecycle | Verified existing locally | Existing authorization, headers, replay/conflict, immutable snapshots, schedules/rollback and legacy HTTP tests pass. |
| 5: eight blocks/localization/core gates | Verified existing locally | Existing shared fixture passes; no source-default injection or text flattening. |
| 6: subcategory/carousel extension | Implemented and tested | Schemas, validators, media/reference traversal, lifecycle compatibility, cache selection and tests updated. |
| 6: picker/filter/completeness | Verified existing locally | Nested tree, descendant-inclusive subcategory filtering, category/brand filters and product pagination exercised with mocked catalog models. |
| 7: product manifest/batch | Verified existing locally | Exact sets/order, 50-ID bounds, 2-KiB request, 2-MiB result, complete DTOs, available/unavailable partition and scoped HTTP/auth regressions. |
| 8: UI assets/public selection/release | Verified existing / extended locally | Narrow upload policy retained; indexed slide readiness, separate release floor, old-client fallback and cache-key tests. Deployed Redis and current real asset acceptance not run. |
| 9: Videos lifecycle/provider/customer delivery | Verified existing locally; live acceptance not run | See the subsequent combined audit for refreshed regression evidence and outstanding actual-byte/permission-race findings. |
| 10: new video product CTA | Implemented and tested locally | Human-approved 50; ordered `productIds`, proposal isolation, replacement, eligibility and public DTO support are implemented. Admin/customer CTA acceptance remains pending. |
| 11: notification platform payload | Verified existing by source inspection | Staff order builder feeds platform options to the actual Firebase send object. No actual send/device test here. |
| 11: outbox/ownership | Verified existing locally, partial | Outbox dedupe/lease/owner regressions pass; current device-token transitions and all denied/revoked account permutations were not live-tested. |
| 12: error/recovery/compatibility | Implemented and tested in changed paths | Existing envelopes preserved, meaningful image field errors, uncertain outcome safety, gated selection. Not a whole-project security certification. |
| 13: joint/live/device acceptance | Not run | Requires separately approved deployed parser/provider/worker/client/device scenarios. |
| 14: frontend/operator responsibilities | Followed | No Hive/template service, frontend alarm, renderer timer, translation proxy, forced build flag or legacy-route deletion. |
| 15: response/documentation | Implemented | Both UI integration guides updated; this report and full offline preparation catalog added. Shared Postman/OpenAPI remote collection not modified. |

## 3. UI Builder: exact additions and integration instructions

Read [the original full guide, chapter 29](UI_BUILDER_FRONTEND_INTEGRATION_GUIDE.md#29-subcategories-and-banner-carousels-october-production-handoff) or [the ID-only guide, section 18](UI_BUILDER_ID_ONLY_INTEGRATION_GUIDE.md#18-subcategories-and-banner-carousels-october-production-handoff). Both contain the complete field dictionaries, full PATCH example, request sequence, retained IDs/revisions/tokens, status/recovery behavior and release dependencies.

Added content:

```json
{"type":"subcategory","value":"68cf1234567890abcdef1238"}
```

```json
{
  "image_urls":[
    "https://media.petyardstores.com/ui-builder/offer-one.webp",
    "https://media.petyardstores.com/ui-builder/offer-two.webp"
  ],
  "aspect_ratio":"16:9",
  "fit":"cover",
  "border_radius":"md",
  "alt_text":{"en":"Pet offers","ar":"عروض للحيوانات الأليفة"}
}
```

These are field-only examples. Use actual returned entity IDs and exact approved ready URLs. A complete layout still requires its normal content/profile/navigation and exact product manifest.

Carousel rules: `image_url` OR `image_urls`, never both. Array form accepts 1–10 distinct safe HTTPS strings and preserves order; FE normally emits the single property for one image. Drafts can omit both while unfinished, but completed preview/release cannot. Empty/invalid arrays, duplicates and unsafe entries are rejected rather than repaired. Every slide is checked even in disabled sections.

Subcategory actions are browse destinations, not products. Their IDs come from `GET /api/v1/subcategories`, recursively traversing `children`. No new active flag is invented on that entity. Current missing destinations fail at their own action path. Category/brand/subcategory IDs stay out of the explicit product manifest. Subcategory image references use the exact stored approved URL, not arbitrary image-delivery transformations.

No builder route was added or removed. The existing builder/batch/legacy inventory remains 22 method/path combinations; ordinary Product create/edit and subcategory picker routes are existing dependencies, not new builder routes.

### New server policy input

`UI_BUILDER_EXTENSIONS_MIN_APP_VERSION` is one optional, strict x.y.z release floor for subcategory destinations and carousel sources. It is exposed as `extensions_min_app_version` in the catalog. It remains absent until an actual supporting customer build is approved. No environment value was set here.

This separate floor prevents a previously approved plain eight-block/ID-only version from automatically receiving unsupported new content. New-profile extended content must target at least both applicable floors. General publication still requires the existing `UI_BUILDER_PUBLISH_ENABLED`; the existing core minimum and legacy cutover flag retain their roles.

New catalog output includes `banner_carousel_draft_storage`, `banner_carousel`, `subcategory_actions_draft_storage`, `subcategory_actions`, `max_banner_images:10`, the action enum/schema additions, image-source exclusivity and `extensions_min_app_version`.

The full [offline preparation catalog JSON](UI_BUILDER_CATALOG_LOCAL_PREPARATION.json) was generated from current code with process-only publication/minimum/queue variables unset. It contains no credentials and is **not** a capture of production's authenticated catalog. Its `meta.source` is artifact provenance, not a newly introduced server response field. The operator still owes sanitized actual `GET /api/v1/admin/ui-builder/catalog` evidence from the approved environment.

## 4. Product images: exact updated contract

Existing route: `PATCH /api/v1/products/:id`. Success remains HTTP 200 with `data` containing the saved product, including the complete ordered `images` gallery. No update idempotency key was added.

### Fields and retained values

| Field/value | Origin | Meaning and reuse |
| --- | --- | --- |
| Path `id` | Product create/detail/list response | Real product ObjectId; never an image public ID or layout UUID. |
| `removedImagePublicIds` | Exact stored `images[].public_id` values selected for removal | Presence opts into merge semantics. `[]` preserves all existing images. JSON accepts an array; multipart empty uses the string `[]`, nonempty accepts indexed fields such as `removedImagePublicIds[0]`. Nonempty IDs must belong to this product. |
| Binary `images` parts | New selected local files | Only new files. Do not upload retained URLs or resend every old image. |
| `mainImageIndex` | FE's planned final gallery | Zero-based integer into retained existing images after removals, followed by new uploads in their selection order. Works without a new file. Null/omission preserves normal selection/fallback; an invalid or fractional index is rejected, not clamped. |
| `variants[].imageIndex` | Same planned final gallery | Uses the same indexing basis, not the upload-only array. A supplied valid index binds that exact image. Null clears the variant image. Omission preserves an existing variant's image only if it remains in the gallery. |
| `variants[]._id` | Existing variant detail | Preserve actual variant identity when sending the existing complete variant-update contract. The images fix does not turn full variant replacement into partial variant PATCH. |
| Returned `images[].public_id/url/isMain` | Saved server gallery | Authoritative ordering and main state. Retain and rebuild local gallery/index mapping from the response or a reconciled detail read. Existing descriptor fields/types remain. |

When the final gallery is nonempty, exactly one image is main. Without a requested main selection, retain the existing main when possible; if none survives, use the normal first available/main upload fallback. An empty final gallery is supported with no main selection; omit a non-null main/variant index when there is no image to index.

Deleting a variant-assigned image clears its dangling reference rather than pointing the variant at an unrelated gallery index. A new supplied index may explicitly choose a replacement. Removing a gallery image does not delete its product or change stock/prices.

### Compatibility window

Clients omitting `removedImagePublicIds` keep the legacy file-upload replacement path. Clients supplying it get merge behavior and the FE handoff's final-gallery index meaning. Main-image-only edits now work without uploads.

An older merge client that assumed upload-only indexes must update its mapping before rollout of this correction. Do not label that old assumption compatible with final-gallery indexing. The FE explicitly reports that its current mapping already uses the combined gallery.

### Ordered examples

Start from retained A/B/C with A main. Add D using the existing multipart route:

```text
removedImagePublicIds = []
images = <binary D only>
mainImageIndex = 3
```

Saved order is A/B/C/D, and D is main. Retain the complete returned list. To remove B, supply B's returned public ID, not index 1 or its URL:

```json
{"removedImagePublicIds":["petyard/products/example/B"],"mainImageIndex":2}
```

The final A/C/D gallery has D at index 2. On a later add E, retained A/C/D precedes E. Explicit empty removal lists must not replace A/C/D. Changing only main to C requires no file:

```json
{"removedImagePublicIds":[],"mainImageIndex":1}
```

Do not reuse old indexes after a removal. Validate all main/variant selections against the final planned gallery, then acknowledge the authoritative returned gallery. Total retained-plus-new images must be <=10 after removal; 11 fails before provider writes. A request removing one of ten and adding one can still save ten.

### Types, bounds and safety

- Product MIME policy remains JPEG/PNG/JPG alias/GIF/WebP/SVG. UI Builder and Video cover upload policies remain narrower; do not copy this policy into those endpoints.
- Actual byte length and declared size are bounded to 5 MiB/file; declared MIME must match decoder output. `image/jpg` maps to JPEG.
- Dimensions are at most 8000 per side and 25 million total decoded pixels, including GIF frames. GIF frames are decoded for validation before keeping the existing animated GIF transport.
- New SVGs must be valid UTF-8 static SVG. XML is parsed with the existing installed `saxes` parser, not a hand-written XML parser. DTD/entities, processing instructions, active/foreign markup, style nodes/inline styles, event handlers, external references, base overrides and animation are rejected. Safe SVGs are rasterized to WebP before storage. Existing SVG records are not automatically rewritten/deleted.
- Product multipart limits: 10 files, 5 MiB each; 1000 text fields, 16 KiB each; 1010 total parts; 100-byte field names; 100 header pairs. The maximum retained field-plus-file payload is about 65.625 MiB; this is **not** a promised raw wire-body/header size cap. Existing global JSON limits remain separate.
- The server's existing media configuration supplies provider timeouts/retries. No new timeout or secret is provided to FE by these image changes. Deployed proxy/client timeouts and incident logs still need operator confirmation.
- Unsupported/malformed/mislabeled files return an operational 400, with safe image findings where applicable, not an unhandled decoder 500. Existing Multer errors use the existing operational error envelope.
- The already installed/locked `saxes` 5.0.1 was declared as a direct production dependency for reproducibility. No package was installed in this task.

### Failure, save outcomes and cleanup

New resources use UUID suffixes to avoid concurrent millisecond-name collisions. Partial provider failures leave the old persisted gallery untouched and clean successfully acknowledged new allocations; cleanup remains the existing best-effort provider behavior.

Old media is removed only after a successful Product save. Errors from post-commit cache/cleanup work no longer trigger rollback deletion of new saved media.

Definite validation/version/cast failures can clean new uploads. Unknown database save outcomes retain new media: a lost acknowledgement may precede a late commit, and one immediate read cannot prove it did not commit. After an uncertain response, read the real Product before a manual retry; this API has no new idempotency guarantee. Proven unused resources may require later operator cleanup. No automatic orphan-media service or CDN purge was added.

The local tests use fake adapters. They do not prove that a current provider upload, reverse proxy, existing SVG asset or CDN eviction is safe in production.

## 5. Product type and SKU: accurate confirmation, no invented migration

The backend does **not** have a fully immutable Product type policy. The route rejects an explicit `type` field, but the current service can infer SIMPLE→VARIANT when `options` is supplied with a nonempty `variants` array. The human chose to retain that behavior while defining migration rules before further changes.

Observed existing rules: the inferred conversion changes the type, clears top-level price/discount/warehouse stock, normalizes options and builds the supplied variants under the current option/warehouse validation. Variant image indexes refer to the current final product gallery. This is a description of the current implementation, not approval to silently convert an existing production product as a test.

Current Product and variant SKUs are optional strings; there is no unique SKU index in the inspected schema. Do not tell FE that nonempty or globally unique SKUs are enforced. No SKU requirement was changed.

Before changing or broadly exposing conversion, agree: explicit versus inferred trigger; permitted direction; who may convert; existing cart/order/variant identities; product/variant SKU rules; price and discount transfer; warehouse-stock migration; options/default variant; image ownership; concurrency; failure recovery and rollback. Existing SIMPLE→VARIANT behavior remains untouched by the image work, and no VARIANT→SIMPLE migration was added.

## 6. Notifications and current-user source confirmation

`sendNewOrderNotificationToAdminsAndModerators` builds the existing `order_detail` / `OrderDetailScreen` action with the real order ID and sends staff push options through `dispatchNotificationToUsers`. The actual dispatcher builds Firebase's multicast message with Android channel `petyard_notification_channel_v7`, sound `petyard_songe`, priority/vibration/visibility/tag; APNs headers and `aps.sound:"petyardSonge.caf"` survive into `messaging.sendEachForMulticast`.

This is source evidence, not an actual FCM receipt or audible device result. Flutter logs showing only notification/data cannot disprove the platform payload. No notification was sent here.

Existing device registration accepts token plus optional supported platform/lang fields and binds it to the authenticated user. Re-registering a known token updates its current owner and clears guest ownership. Inbox GET/PATCH/DELETE methods remain unchanged and owner-scoped. The outbox model/claim/dedupe and guest mutation tests passed; all account-switch/revocation and physical-device cases still require approved acceptance. No exactly-once physical delivery claim is made.

`GET /api/v1/users/me` uses current authenticated user resolution and returns that user under `data`, including its current role. This is the existing menu role source, not a new endpoint. Actual profile reliability on the selected environment and frontend menu fallback are not tested here.

## 7. Tests, review and what still needs evidence

Fresh final focused/shared proof: **140 passed, 0 failed, 0 skipped**. External database/media/Firebase adapters were mocked; local HTTP sockets were permitted for parser/auth/transport tests. This includes adding after an earlier removal, replacing one image in a full ten-image gallery, combined variant-image indexes/omission/null behavior, and valid GIF-byte preservation.

The first 109-case run inside the sandbox had 101 passes and eight HTTP connection EACCES failures. The identical suite passed 109/109 after localhost permission. Those were environment failures, not hidden skipped tests. Product red tests were run before fixes and reproduced five image-state defects plus three file-validation defects. Final tests passed after the fixes.

Commands:

```powershell
$uiPhaseTests = (Get-ChildItem -LiteralPath 'test/domains/uiLayout' -Filter '*.test.js').FullName
node --test --experimental-test-isolation=none --test-concurrency=1 --test-reporter=spec $uiPhaseTests test/domains/product/productBatch.test.js test/domains/productAdminDetailList.test.js test/domains/productWarehouseStocks.test.js test/domains/productImageUpdates.test.js test/domains/videos/public/productMedia.test.js test/domains/collectionProductVisibility.test.js test/domains/substitution/substitutionOfferQuote.test.js test/domains/notification/notificationOutbox.test.js test/shared/imageValidation.test.js test/shared/imageUpload.test.js test/shared/imageDelivery.test.js test/shared/privateImageDelivery.test.js test/shared/mediaConfig.test.js
```

Independent source review found no UI extension defect. Its Product review identified the original 1000×1-MiB text-field buffering risk; that was corrected to bounded 16-KiB fields/parts and tested through multipart requests. Recheck found no remaining actionable security/data-loss issue in the changed image source. The reviewer did not independently run the tests or certify production.

Still required: approved current staging/live record scope; deployed revised catalog; deployed parser/provider/image gallery cases; worker/cache and old-client behavior in that environment; current device-registration/revocation tests; actual Android/iOS rendering, playback/sound and signed build identity; admin/customer integration of the now locally implemented Videos CTA contract; agreed conversion migration rules; release owners, rollback target and rollout approval. The combined response distinguishes corrected audit findings from the accepted direct-upload container limitation.

No automatic live acceptance, configuration edit, database migration, asset rewrite, shared Postman update, commit/push or deployment is implied by this report.
