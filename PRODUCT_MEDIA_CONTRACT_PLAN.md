# PetYard Product Media Contract Plan

Status: Proposed for review; not implementation authority yet.

## Outcome

Product detail responses keep the existing `images` field unchanged and add a
new `media` field. The new field is an ordered, response-only projection of the
product's existing images followed by its active, playable Product Videos.

This gives the new Flutter client one gallery Interface while preserving the
old client contract. Product cards and product-list responses continue to use
images only.

## Public response shape

`media` is a discriminated union. Every item has a stable `id`, a `type`, and a
zero-based `position` in the returned gallery.

```json
{
  "images": [
    {
      "public_id": "petyard/products/cat-food/front",
      "url": "https://media.example/front.webp",
      "isMain": true
    }
  ],
  "media": [
    {
      "id": "image:petyard/products/cat-food/front",
      "type": "image",
      "position": 0,
      "public_id": "petyard/products/cat-food/front",
      "url": "https://media.example/front.webp",
      "isMain": true
    },
    {
      "id": "68f0f95f4e12d03b3311fabc",
      "type": "video",
      "position": 1,
      "posterUrl": "https://media.example/video-cover.webp",
      "durationSeconds": 42,
      "width": 1080,
      "height": 1920,
      "aspectRatio": 0.5625,
      "canSave": false,
      "playbackHref": "/api/v1/product-videos/68f0f95f4e12d03b3311fabc/playback"
    }
  ]
}
```

## Field rules

### Common fields

- `id`: Stable gallery-item key. Image IDs are namespaced from the existing
  `public_id`; video IDs are Product Video placement IDs.
- `type`: Exactly `image` or `video`.
- `position`: Zero-based final position after the backend removes unavailable
  entries and normalizes the response.

### Image item

- `public_id`, `url`, and `isMain` preserve the existing image descriptor.
- The image data is duplicated only in the response projection. It is not
  duplicated in MongoDB or Bunny Storage.

### Video item

- `posterUrl`: Stable cover URL, or `null` while the copy is pending/retrying.
  The local worker copies the selected provider thumbnail into the existing
  public Bunny image pipeline after the asset becomes ready, using one
  deterministic WebP object per asset generation. No signed Stream thumbnail
  URL is returned here. Optional custom Cover Image replacement is still
  pending implementation. See the 2026-09-30 poster checkpoint in
  `VIDEOS_IMPLEMENTATION_PLAN.md` for tests and remaining live gates.
- `durationSeconds`, `width`, and `height`: Provider-verified metadata captured
  after processing. `aspectRatio` is derived as `width / height`.
- `canSave`: Always `false` for a product-only representation. Saveable Reel
  and YouTube Video representations return `true` in their video responses.
- `playbackHref`: PetYard endpoint that verifies current visibility and returns
  a fresh short-lived, path-tokenized HLS URL. The product response never
  contains a long-lived Bunny playlist URL.

The public item must not expose Bunny library IDs, Bunny video GUIDs, API keys,
provider status numbers, upload filenames, moderation notes, or internal audit
data.

## Ownership and assembly

The design separates the deep modules and keeps provider details behind an
Adapter:

- Product owns the existing embedded `images` array.
- Video owns Videos-feature editorial identity, localized metadata,
  publication state, and its active Video Asset relationship. It is created
  only for YouTube Videos and Reels, not for product-only uploads.
- Video Asset owns Bunny provider identity and processing state. Each asset
  belongs to one Reel upload or one Product Video upload; the two workflows do
  not share assets.
- Product Video Placement owns `productId`, its Video Asset relationship,
  `showInReelsFeed`, visibility eligibility, and its immutable attachment
  sequence.
- The product-detail presenter is the assembly Seam. It combines Product images
  with eligible placements into the public `media` Interface.

A Product Video does not receive a canonical Video or Reel record. Its
reels-style appearance is computed from the Product Video Placement and uses
the same asset as its product gallery representation, without another upload.

## Availability rule

A video appears in public product `media` only when all of these are true:

1. The product is publicly accessible.
2. The Product Video placement is active under the product-editing workflow.
3. Its Video Asset is `ready` and has verified metadata.
4. The asset is still the active one. A pending replacement or unresolved
   explicit deletion does not by itself hide the currently active video.

An inactive product suppresses both its Product Videos and Product Video Feed
Entries from public views. Zero stock does not suppress them. Reactivating the
product restores eligible entries without recreating records.

Permanently deleting the product, or removing a Product Video placement,
permanently removes its product-sourced reels-style entry. This is not an
independent editorial item once its source placement no longer exists.

If a Product Video becomes unavailable, it disappears from `media` while the
legacy `images` response stays unchanged.

## Upload policy

Product Videos use the same MVP media limits as Reels: MP4 or MOV, at most
250 MB, and at most 90 seconds. The provider's acceptance of an upload does not
replace PetYard's validation before issuing upload authorization or its
provider-verified duration check after processing.

A product may have at most three active Product Videos. Product-only videos do
not require an independent title or description.

Product creation keeps its current product/images multipart request. If no
videos were selected, no Bunny Stream or Product Video endpoint is called. If
videos were selected, the frontend waits for successful product creation and
its returned ID, then requests Product Video upload sessions and uploads the
bytes directly to Bunny using TUS. The backend records file-selection order
before upload begins; upload completion order never changes gallery order.

Product creation is not rolled back when a later video upload fails. Pending or
failed videos are absent from public `media` and feeds, while the created
product remains usable and the admin can retry through product edit.

After product creation, the frontend submits all selected video metadata in one
batch. The backend atomically validates available capacity and reserves the
files' selection order before returning up to three six-hour TUS upload
sessions. The browser uploads no more than two files concurrently.

Each batch file descriptor carries a frontend `clientId`, filename, MIME type,
byte size, and initial `showInReelsFeed`. The session response echoes
`clientId`, stable Product Video ID, reserved position, TUS instructions, and
expiry. An expired six-hour authorization refreshes the same Product Video
slot and Bunny video before the 24-hour abandonment deadline if the provider
upload resource remains resumable; the provider-expiry fallback still needs a
verified rule.

If provider authorization refresh still cannot resume an expired TUS upload
resource, preserve the Product Video placement ID, slot, and gallery position,
create a replacement Bunny resource for that placement, and durably clean the
unusable provider resource. Verify this fallback against Bunny in the canary.

`awaiting_upload`, `processing`, and `ready` Product Videos reserve the product's
three slots. A temporary transport interruption remains resumable and does not
change state to terminal failure. An unfinished upload is abandoned after 24
hours. Terminal processing/validation failures, explicit cancellation, and
abandonment remove the Product Video and failed asset from the product, release
the slot, and enqueue idempotent Bunny deletion until no provider resource
remains. Only sanitized audit and cleanup-job data survives; it contains no
video bytes or reusable playback/upload credentials.

Batch setup is all-or-nothing before the frontend receives upload sessions. If
any provider/session creation fails, expose no sessions, remove all batch
entries, and enqueue cleanup for every Bunny resource already created. After a
batch is successfully issued, uploads are independent: one terminal failure or
cancellation never stops the others.

Explicit cancellation stops TUS, removes the pending Product Video, releases
its slot, and schedules provider cleanup immediately. A sanitized upload-attempt
audit remains for 30 days with the product, actor, safe filename, timestamps,
stage, and safe failure reason only. A direct retry reuses the original
selection position; a new unrelated upload appends after existing videos.

## Product edit operations

Ordinary product/image edits continue through the existing product PATCH.
Adding, replacing, removing, or changing `showInReelsFeed` uses dedicated
Product Video operations only when the edit actually includes those changes.

A replacement creates a pending asset while the old video remains playable in
its existing position and feed state. When Bunny confirms the replacement is
ready, one local cutover moves the position and `showInReelsFeed` to the new
asset. Terminal replacement failure cleans the new asset and leaves the old
video unchanged. Only one replacement may be pending per Product Video.

Explicit removal first persists a durable deletion intent and sends Bunny's
delete request. The Product Video remains attached and publicly available until
Bunny confirms acceptance. A rejected request preserves the Product Video and
returns a safe admin error. After acceptance, PetYard removes it from product
media/feed and releases its slot while the durable record protects completion
if the local post-provider update initially fails.

Deletion outcomes are explicit and idempotent:

- Bunny `2xx`: remove the Product Video locally.
- Bunny `404`: the provider resource is already absent; treat this as success
  and remove locally.
- Bunny `400`, `401`, or `403`: preserve the Product Video and return a safe
  admin error.
- Bunny `429` or `5xx`: preserve it and retry through the durable job.
- Network timeout or otherwise unknown result: preserve it initially, query
  Bunny, and remove locally only after confirmed absence or successful retry.

While this explicit deletion is unresolved, administration shows
`Deleting...` and disables replacement, `showInReelsFeed` mutation, and repeated
deletion. Public playback remains available until provider deletion is accepted
or absence is confirmed.

Deleting the whole product is a separate cascade: persist cleanup jobs with all
required provider identifiers, cancel/tombstone active video work, remove
public exposure, then remove the product. Cleanup jobs survive the product
document and continue retrying. Bunny unavailability never blocks whole-product
deletion after those durable jobs exist.

Normal product fields remain editable during uploads and processing. Pending
videos may be cancelled, and new videos may be added whenever live reserved
capacity is below three.

## Ordering

Product `media` always returns the existing image array first, preserving its
current order, followed by eligible Product Videos in upload/selection order.
Images and videos cannot be interleaved, and there is no reorder operation, so
the existing image descriptors do not need a new gallery-position field.
Public responses still emit normalized `position: 0..n-1`.

## Player presentation

The product gallery displays a poster and never autoplays. A tap starts inline
playback; leaving the item pauses it. Controls include play/pause, seek, mute,
and fullscreen. Both product and reels-style players preserve the entire source
using contain/letterboxing on a neutral background and never crop or upscale
beyond the available rendition.

The reels-style feed autoplays only the centered item, pauses every other item,
preserves the user's mute preference, and exposes play/pause, mute, and progress
controls.

## Caching and playback

- The current shared Product detail cache contains only the base Product DTO,
  including legacy images. The response's `media` array is projected afterward
  from fresh placement, Product and active-asset reads, even on a base-cache hit.
  Stable poster URLs and `playbackHref` are safe public metadata, but the current
  implementation does not put the video projection into that shared cache.
- Videos lists, feeds, detail and saved lists currently have no shared server
  cache. They query current publication/media state and compute `isSaved` for
  the supplied identity on every request. User and guest saves remain separate.
- Product `isFavorite` and restock-subscription state are also computed outside
  the shared base cache. Never cache identity-specific state or signed HLS URLs.
- Product detail, Videos reads and playback grants return
  `Cache-Control: private, no-store`. A Flutter screen must request fresh data
  when it needs changes; these headers do not update an already-rendered screen.
- `playbackHref` is `GET /api/v1/product-videos/:id/playback`; calling it
  returns `{ "url": "...", "expiresAt": "..." }` after rechecking current
  product, placement, and active-asset eligibility.
- Flutter requests playback only when the video is opened or preloaded and
  refreshes it near expiry.
- Product Video analytics use the Product Video Placement ID, Video Asset ID,
  product ID, and a server-issued playback-session ID. Provider identifiers
  remain private.

### Q138 transition and cache review — 2026-10-02

Q138 requires invalidating affected caches after committed changes. Fresh reads
are used instead where no derived cache exists; do not introduce a feed cache
or new cache keys merely to invalidate them. Existing Product invalidation
deletes `product:<id>:*` and advances the Product list-cache version.

| Committed change | Current Product detail behavior | Current Videos/feed behavior |
| --- | --- | --- |
| Initial verified readiness | Product Video service invalidates Product caches after the placement becomes ready; fresh media reads require the owned active asset to be verified ready. | Product/all feeds use fresh eligible-placement/Product/asset aggregation. |
| Product replacement | The old active asset remains public until the transactional cutover. The service queues old-generation cleanup and invalidates Product caches only after persistence. Fresh media reads follow the new `activeAssetId`; pending assets never enter the gallery. | Fresh feed queries use the same current-asset eligibility rules. |
| Product activation/deactivation or renaming | Product save is followed by existing Product cache invalidation. Public detail checks current Product activity before reading the base cache; staff inactive-product access remains unchanged. | Product aggregation reads the current Product, requires `isActive: true`, and uses its current localized name. Zero stock is not a media visibility condition. |
| `showInReelsFeed` change | Product Video service invalidates Product caches after the committed edit. The gallery does not apply this feed-only flag. | Product/all feeds apply the current flag in their fresh queries. |
| Poster attachment | Fresh media reads expose the copied poster URL when available, or `null` while pending. No video/poster projection cache needs invalidation. | Feed/detail reads use current copied posters or eligible attached editorial covers. |
| Editorial publication, unpublication, review cutover, cover or position change | No Product detail cache contains editorial Videos. | Current publication/active-media/cover/order reads replace feed-cache invalidation. Pending changes are not public DTO fields. |
| Explicit Product Video deletion | A durable delete request or queue acknowledgement does not hide current ready media. Recorded Stream acceptance or confirmed absence makes the asset ineligible, then placement removal invalidates Product caches. Rejected/retrying deletion preserves current media. | Fresh Product/all feed queries use the same acceptance boundary. |
| Whole Product deletion | Product deletion and video tombstones/cleanup obligations commit before Product cache invalidation. The public activity check prevents cached deleted Product detail from being returned. | Fresh joins cannot expose the deleted Product; durable cleanup continues independently. |
| Editorial deletion or save mutation | No effect on the shared Product base DTO. | Deleted editorial content is excluded by fresh owner reads. Typed user/guest save state is read per request; Product Video entries always have `canSave: false` and `isSaved: false`. |

Playback grants recheck eligibility and the current generation before returning
the signed URL, with a configured lifetime no greater than 900 seconds. A flag
rollback, unpublish, deletion or generation switch prevents a new grant once
observed; it does not revoke a URL that has already been issued. Existing URLs
can remain usable until expiry or provider removal. Cache invalidation is not
token revocation.

Source review covered Product detail/update/delete and cache services, public
media/feed/playback services and repositories, Product Video transition
services/repositories, poster handling and worker callback wiring. The focused
local suite passed 81/81 existing tests across nine files on 2026-10-02.
Database/provider/cache-side effects are faked or disabled in these tests;
cache-hit placement was verified by source inspection, not real Redis. Actual
Mongo aggregation/index/transaction behavior, Redis invalidation and worker
delivery, Bunny/CDN behavior and device rendering remain V4.A/V9 acceptance
gates. No production code or rollout switch changed during this review.

The product gallery has no Video Save control. Product Favorites remain the
only save behavior on that screen. Product Video Feed Entries are also not
saveable; real Reels remain separate and saveable.

Every public video/feed item exposes a computed `canSave` boolean. Product-only
representations return `false`; Reel and YouTube Video representations return
`true` in save-capable video views. Flutter uses this capability instead of
inferring behavior from route or media source.

## Short-video feed

Use `GET /api/v1/videos/feed?kind=reel|product|all`, with `kind=reel` as the
default. Product entries are newest-attachment-first. `kind=all` unions real
Reels and eligible Product Video Feed Entries. Because their uploads and assets
are independent, cross-type asset deduplication is unnecessary. Product entries
link to their product and are not saveable.

Every feed item contains `kind: "reel" | "product"`. Reel entries expose
`canSave: true`. Product entries expose `canSave: false`, `productId`, and
`productHref`. Flutter uses the discriminator and capabilities rather than
inferring behavior from IDs.

Each Product Video placement has `showInReelsFeed`, defaulting to `true`.
Super admins and admins with `PRODUCTS` may change it through product
create/edit. When false, the Product Video stays in the product gallery but is
excluded from `kind=product` and `kind=all`; turning it on restores an entry
only when the product is active and its asset is ready.

`kind=all` is newest-first using Reel publication time or Product Video
attachment time. Manual Reel positions apply only to `kind=reel`. Pagination
uses the repository's established `page`/`limit` contract and returns
`{ totalResults, totalPages, page, results, data }`.

Product Video uploads exist only in product create/edit and require the existing
`PRODUCTS` authority. Real Reel uploads exist only in Videos administration and
require `VIDEOS`; no promotion action connects the workflows. Product Video
Feed Entry titles resolve from the product. When a replacement finishes in
Bunny, the Product Video placement switches atomically so both gallery and feed
use the new asset.

Anonymous/customer product detail returns not-found for inactive products;
authorized product administration may still retrieve them. This aligns direct
detail access with the existing active-only public listing rule.

Provider deletion is ownership- and replacement-aware and asynchronous. A
Video Asset can be deleted from Bunny only after its owning Product Video or
Reel and every active replacement/pending cutover stop referencing it. Failures
remain retryable and never fail the synchronous mutation after its database
commit.

## Background provider operations

Every asynchronous or retryable Bunny reconciliation and deletion obligation
that must survive a request or process failure is represented by a durable
MongoDB Video Provider Operation. BullMQ is the primary execution mechanism:
jobs carry the operation ID, workers atomically claim the corresponding
database record, and repeated delivery is idempotent. The queue payload is not
the source of truth and does not contain reusable credentials.

Initial Bunny resource creation remains inside the upload-session request
because that response must return usable TUS credentials. It records enough
local state first and persists compensating cleanup for every uncertain or
partially created provider resource before returning failure; the API never
waits for a BullMQ worker to manufacture the upload session.

After committing an operation, the application attempts to enqueue it. A
lightweight MongoDB sweeper periodically finds pending work and expired worker
leases, then enqueues or processes it again. This covers enqueue failures,
Redis outages, worker crashes, and queue retention without losing the cleanup
obligation. Provider calls never run while a MongoDB transaction is open.

The persistence boundary uses separate collections for `Video`, `VideoAsset`,
`ProductVideo`, `VideoSave`, `VideoProviderOperation`, and
`VideoUploadAttempt`. Product Videos are not embedded in Product. A
`ProductVideo` owns its stable placement ID, product reference, immutable
selection position, feed visibility, active asset, optional pending
replacement, and lifecycle timestamps. Each Video Asset has exactly one typed
owner (`reel` or `product_video`) and a unique Bunny GUID.

Multi-record local mutations use MongoDB transactions, including capacity and
position reservation, initial record creation, replacement cutover, explicit
deletion intent plus provider operation, and whole-product cleanup preparation.
Neither Bunny nor Redis calls run inside those transactions.

Use a dedicated `video-provider` BullMQ queue and worker. Jobs contain only a
Video Provider Operation ID and use that ID as `jobId`; the worker reloads all
authoritative data from MongoDB and additionally takes an atomic database
lease. The initial job set is asset reconciliation, asset deletion, abandoned
upload cleanup, and unknown-deletion verification. Worker concurrency starts
at three, is bounded by validated configuration, and serializes work targeting
the same Bunny GUID.

Transient provider operations retry with exponential backoff and jitter capped
at 24 hours. Ten failed attempts add `needs_attention`, monitoring visibility,
and a super-admin immediate-retry action, while one automatic daily retry
continues until resolution. Completed operations expire after 90 days;
unresolved operations remain. Sanitized upload attempts expire after 30 days.

Validated Bunny webhooks are deduplicated hints. The handler persists and
enqueues reconciliation, then returns quickly. A worker fetches current Bunny
state before making a local transition, and the sweeper also finds assets stuck
in `awaiting_upload` or `processing`. Technical state is monotonic: delayed
events cannot regress a ready asset or revive terminal cleanup.

The Videos module owns Product Video application logic, Video Assets, Video
Provider Operations, the queue and worker, and one Bunny provider adapter.
Product controllers and services call the Product Video application service;
they never call Bunny or BullMQ directly.

## Versioning

- `/api/v1` keeps `images` and adds `media`.
- The new Flutter release reads `media` and falls back to `images` only if the
  field is absent during a rollback or mixed deployment.
- A future `/api/v2` may make `media` the only gallery field after production
  adoption is measured. Removing `images` from `/api/v1` is not part of this
  feature.

## Open decisions

- Exact Product Video upload/edit/status request and response DTOs, plus
  operation-specific error codes. Playback route and player controls are
  settled in Q71, Q72, and Q120.
