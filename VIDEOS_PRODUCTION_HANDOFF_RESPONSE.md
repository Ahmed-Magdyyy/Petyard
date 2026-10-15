# PetYard — Videos production handoff response

Date: 2026-10-15, Africa/Cairo.
Input: `PHASE_BACKEND_PRODUCTION_HANDOFF.md` dated 2026-10-14, supplied in Downloads.
Scope: section 9, the approved section 10 extension, video-specific section 11,
and Videos acceptance/error/compatibility requirements in sections 12–13.
UI Builder, Product image/type behavior and shared notification code are owned
by the other conversation and were not modified here.

Final audit follow-up: [PHASE_BACKEND_PRODUCTION_RESPONSE_AND_INTEGRATION_GUIDE.md](PHASE_BACKEND_PRODUCTION_RESPONSE_AND_INTEGRATION_GUIDE.md) is the current combined FE response. Editorial persistence now fences current User authority inside the same transaction as request-driven metadata mutations, and request IDs precede body parsing. The owner chose to retain direct uploads and document the original-container inspection limitation. Refreshed combined result: 877 passed, 0 failed, 5 external skips; not production acceptance.

The combined response also covers corrected new-order outbox deduplication, current staff eligibility at delivery and UI asset ambiguous-save cleanup. They are internal fixes, not changes to the `productIds` request contract. The sections below retain the original phase evidence; use the combined response for current status and remaining live acceptance rather than treating historical test counts as the final gate.

## Environment, revision and evidence boundary

The inspected local baseline is **08ac5b9**. The continuation chat is completed,
not running a competing implementation. Other local UI/Product changes are
preserved. The linked-product extension below is uncommitted local work after
that baseline; neither its presence nor local tests make it deployed.

The user-supplied VPS report states revision 08ac5b9, seven online PM2 processes,
seven signed Bunny callbacks receiving HTTP 202, exact test-video management
GET 404, and an empty library afterward. These are **reported deployment and
callback/cleanup results**. This task did not repeat that deployment inspection,
contact the VPS or Bunny, create test media, write a real database/Redis, send a
notification, change flags/secrets, install packages, commit, push or deploy.
Actual application/player/device acceptance remains distinct from callbacks.

## Section 10 — implemented additive linked-product contract

The human approved **50 products per general YouTube Video/Reel**, matching the
existing batch maximum. No compatible general-Video field existed, so the
single new field is **productIds**. Documentation label
**videos-product-links-v1** is not a new wire field or database revision value.

| Operation/surface | Implemented behavior |
|---|---|
| Existing POST `/api/v1/videos/admin` | Optional ordered `productIds`, omission `[]`; existing kind/metadata/role/publication policy unchanged. |
| Existing PATCH `/api/v1/videos/admin/:id` | Omission preserves; `[]` clears; supplied array replaces the complete ordered selection. No new revision/header requirement. |
| Validation | 0–50 exact 24-hex strings; lowercase canonicalization, ordered retention, case-insensitive duplicate rejection; no sorting/deduplication/truncation. `null`, malformed/non-string IDs, missing/inactive products and overflow reject with 422. |
| Eligibility | References must exist with `isActive:true` at metadata authoring, review/submission/publication and automatic application. This reuses existing public catalog eligibility, not a new stock/warehouse or price policy. Later changes resolve through live product reads. |
| Error envelope | Existing `{status,error,message}`; `error[0].code:VIDEO_INVALID_PRODUCT_IDS` and safe `field:productIds` or indexed field path. Other endpoint status codes/envelopes remain unchanged. |
| Admin/proposal DTOs | Active `productIds` plus independent `pendingChange.content.productIds`. Old records read as empty arrays without migration. |
| Review/replacement/cover | Admin proposals do not alter active CTA until existing approval/application. Rejection/cancellation preserves active links. Replacement reservation copies links; reviewed/automatic cutover moves them atomically with media. Cover proposals retain them. |
| Automatic initial publication | Eligibility checked after preview; conditional publication fences the exact link selection, including legacy missing/empty values. It does not turn a pending proposal into public links. |
| Public DTOs | YouTube/Reel list, feed, detail and saved items include only active published `productIds`; never pending links or copied commerce. Legacy result `[]`. |
| Product Videos | Unchanged singular `productId`/`productHref`; no general links field on their requests, feed or gallery. |
| Customer hydration | Existing POST `/api/v1/products/batch`, `{ids:[...]}`. Client restores authored order, handles `unavailable_product_ids`, and opens product details/variant selection. No new product-snapshot endpoint or custom CTA fields. |
| Later inactive/deleted linked product | Does not break video playback or erase editorial media; batch reports current unavailability. No frozen prices/stock or unsupported Add to cart shortcut. |

PATCH example (field-only; create still requires its existing content):

```json
{"productIds":["68cf1234567890abcdef1235","68cf1234567890abcdef1234"]}
```

Clear example: `{"productIds":[]}`. To retain links, omit the key. An older
client/server without the field must still display/play the Video without CTA.
Existing numeric `revision`, reviewer/author/timestamps and proposal metadata
are retained. There is no new immutable editorial history API in this phase.

Implementation: `editorialProductLinks.validators.js` and `.repository.js`,
existing editorial model/validators/service/repository, public projection and
Reel upload/lifecycle repositories/services under `src/domains/videos`.
No shared Product batch/image, app/config/enums or notification files changed.

## Sections 9, 11–13 — existing contract verification

**Verified existing** below means source inspection plus relevant local
regressions, not a new live end-to-end run. An unchecked input acceptance box
was not treated as a missing feature.

| Checklist group | Result and evidence |
|---|---|
| §9 routes/envelopes | Verified existing. Same 53 client routes and existing Product/notification touchpoints. `editorialVideo.routes.js`, public/Product/analytics/provider routers and controllers remain authorities; no new route. Frontend dictionary and Videos Postman collection updated. |
| §9 metadata/YouTube | Verified existing. Trimmed UTF-16 code-unit lengths 160/2000; supported HTTPS watch/shorts/youtu.be canonicalization and server YouTube verification. SuperAdmin YouTube create publishes; admin create drafts. `editorialVideo.validators.js`, `.service.js`, `youtubeVerifier.js`; editorial/verifier tests. |
| §9 permissions/state | Verified existing. Existing protect, verified-phone, roles and videos/products/analytics controls retained. Owner/session/purpose/generation/revision fences and active versus pending state preserved. Router/auth/service and guarded transaction/CAS tests; no authorization middleware changed. |
| §9 upload/recovery | Verified existing locally. Backend-created resources, scoped grants, original manifest/key/session replay, 201 issued versus 202 pending/recovering; original horizons and recovery/cancellation retained. Reel/Product recovery, trusted-upload and HTTP tests. No fresh actual provider HEAD/PATCH/offset test here. |
| §9 media validation | Manifest MIME/extension/positive byte length and 250 MiB limit verified. Processing readiness requires provider status 4 plus duration >0 and <=90, dimensions and encodes. Backend receives no upload bytes and does not independently sniff the uploaded MP4/MOV container; actual spoofed-container/declared-length rejection requires provider/application acceptance. Do not label that byte-validation item complete from manifests alone. |
| §9 replacements/deletion/late events | Verified existing locally. Current media survives pending failure/cancel; cutover is conditional; durable Mongo operations precede execution; TUS termination and management absence are separate from local removal/CDN cache. Worker, webhook, replacement/cleanup/race regressions remain green. |
| §9 covers | Verified existing. Dedicated multipart cover, <=5 MiB, actual Sharp decode, JPEG/PNG/WebP, no animation, orientation/portrait/dimension limits and configured pipeline errors. Cover store/lifecycle tests. Product image format widening in the other chat does not widen this contract. |
| §9 Product allocation | Verified existing. Batch 1–3 files, correlation by clientId, transactional total capacity <=3, 90-second final provider limit, gallery/feed/position distinctions. Product application/replacement/media tests. No general Video approval added to Product workflows. |
| §9 previews/analytics/reports | Verified existing. Staff preview remains separate from customer analytics; session/media/identity fencing, Cairo dates/pagination and null-versus-zero metrics retained. Preview and analytics suite evidence; no telemetry/count implementation changed. |
| §9 operations/retry | Verified existing. SuperAdmin-only operation list/retry, needs_attention CAS, actual queued boolean, durable queue-loss recovery and retained attempt/error history. `videoProviderAdmin.*`, operation service/repository and tests. Retry is not execution/physical deletion proof. |
| §11 video alerts | Verified existing. YouTube playback-error reports target active non-deleted/non-banned superAdmins and videos-authorized admins, deduped per Video/YouTube/UTC day/recipient. Current owner/link/state fenced; notification outbox reused. `publicVideoError.repository.js` and player-error/outbox tests. |
| §11 identifiers/ownership | Verified existing source. Push referenceId is Video ID; inbox id is notification ID. Dispatcher resolves tokens by current user/guest owner; registration rebinds a rotated/shared token to its current owner. Inbox operations use current caller ownership. Historical alerts grant no Video access; frontend refetches protected detail. Shared notification files were not changed. |
| §11 sounds/device delivery | Not run on physical devices here. Shared dispatcher preserves provided Android/APNs options; this existing Video error alert does not supply the order-specific custom sound example. No new alert sound policy is invented. SuperAdmin foreground alarm, bundled CAF/resource identity, Focus/Silent Mode and signed device builds remain client/release acceptance. |
| §12 errors/privacy/compatibility | Verified locally for changed contract. Existing HTTP/status/envelopes retained; safe link field errors, old empty-link reads, pending privacy, Product compatibility and source-owned IDs preserved. No bearer/provider grant added to public content. Server X-Request-Id/global early-parser behavior remains existing app behavior, not a new guarantee on every response. |
| §13 joint backend/client/provider acceptance | Not run as a new live campaign. Existing selected external evidence remains in `VIDEOS_BACKEND_ACCEPTANCE.md`; new local extension is not covered by those old approvals or the reported VPS callbacks. |

## Proof and review

`test/domains/videos/editorial/editorialProductLinks.test.js` exercises the
existing service/HTTP seams with real local repositories/lifecycle and fake
database/provider adapters. Cases cover ordered create/omission/clear, 50,
invalid/duplicate/inactive/missing inputs, draft/pending isolation, rejection,
cancel, publication revalidation, initial auto-publication races, replacement
copy and reviewed/automatic cutover, plus existing HTTP route envelopes/errors.
The public service regression covers lists/detail/saves and excludes Product
Videos. Existing exact DTO/CAS tests were updated only for additive fields.

Independent review identified a real Mongoose ObjectId-versus-string failure
in replacement application. The strengthened regression hydrates transactional
reads as actual EditorialVideoModel documents: it failed before the fix and
passed afterward for manual and automatic paths. Internal IDs normalize before
eligibility checking; external payload validation remains strictly string-only.
Malformed internal values still fail validation rather than becoming empty.

Final verification on 2026-10-15:

```powershell
$videoLinkTests = @(rg --files test/domains/videos -g '*.test.js')
node --test --experimental-test-isolation=none --test-reporter=tap @videoLinkTests `
  test/domains/notification/notificationOutbox.test.js `
  test/domains/notification/substitutionNotificationDelivery.test.js
node postman/check-videos-collection.mjs
node scripts/videos-handoff-drafts-20261010/check-handoff.mjs
```

- Combined Videos plus two notification regression files: **734 tests,
  729 passed, zero failures, five external opt-in skips**, 6.1 seconds.
- Linked-product service/HTTP file: **11/11**; public projection regression is
  included in the combined run. Red-before-green proof covers create, edit,
  publication eligibility, public DTOs, automatic publication and hydrated
  Mongoose replacement behavior.
- Self-contained collection checker: 53 client routes, 62 requests, 354 synthetic
  response examples, 26 validated request bodies, 11 analytics event types;
  zero errors. Four existing create/edit request examples/descriptions now
  document links; saved historical examples may omit this additive field.
- Detailed frontend guide checker: 98 local links, 23 JSON examples, 116
  headings/anchors, no missing frontend domain codes and zero errors.
- Independent focused review's ObjectId issue was corrected and rechecked.
  New source/tests and documentation passed scoped syntax/whitespace checks.

The normal suite leaves external acceptance opt-in; skipped tests are not fresh
live evidence. Initial sandbox HTTP failures were loopback `EACCES`, resolved
by permitted local HTTP execution, not by weakening assertions. Two actual
compatibility failures in an earlier local run were corrected: the legacy
publication-CAS fixture now recognizes the added link fence, and the replacement
proposal fixture accounts for the additive empty-array default. The final run
above contains no failing tests.

## Remaining release and client gates

1. Admin implements the ordered picker/decoder with omission versus clear and
   separate active/proposal selection; customer implements CTA/product batching,
   variants and unavailable-product handling.
2. Release owner approves an exact environment/revision, actors/records/actions,
   provider/media and notification scope, signed builds and rollback target.
   No current live scope is granted by this response.
3. Run the handoff's real application upload/resume/recovery/publication/playback,
   covers/order/capacity, revoked-role and physical notification/CTA scenarios.
   Record sanitized request IDs and actual results, not only send receipts.
4. Separately approve deployment/activation of this new extension. Existing VPS
   baseline 08ac5b9 is evidence of the preceding release, not an automatic new
   rollout or an approved rollback operation.
5. UI Builder's missing approved compatible customer version remains the other
   chat's release gate. No UI Builder compatibility switch was changed here.

API handoff: [VIDEOS_FRONTEND_HANDOFF.md](VIDEOS_FRONTEND_HANDOFF.md).
Collection: [Videos.postman_collection.json](postman/Videos.postman_collection.json).
Historical operational scope: [VIDEOS_BACKEND_ACCEPTANCE.md](VIDEOS_BACKEND_ACCEPTANCE.md),
[VIDEOS_GITHUB_RELEASE.md](VIDEOS_GITHUB_RELEASE.md).
