# PetYard Videos Feature Decisions

This document records the product and architecture decisions for the Videos
feature as they are settled. It is the durable record for the grilling process;
pending items are not implementation authority.

## Status

- Phase: product design accepted; engineering contract review before coding
- Started: 2026-09-14
- Implementation baseline: `c010f3c`
- Provider research: `BUNNY_STREAM_VIDEOS_RESEARCH.md` (complete; Bunny Stream
  accepted in Q9)
- Additional design input: shared Codex Cloud conversation reviewed on
  2026-09-16, beginning with the product-image/Bunny and Reel question.
- Product decisions are accepted through Q162. The design interview has no
  known open product-decision frontier; exact engineering schemas, provider
  canary evidence, and implementation tickets remain to be drafted and reviewed
  before the user confirms shared understanding and feature coding begins.

## Established constraints

- PetYard is adding a Videos feature with two distinct content forms.
- One form references a YouTube video and is displayed by the mobile app using
  an embedded YouTube player in an OS-provided web view.
- The other form is short, vertically consumed video uploaded by PetYard super
  admins and admins and displayed in a reels-like mobile experience.
- PetYard already uses Bunny for image storage and delivery. Reels use Bunny
  Stream in a dedicated Video Library for ingest, transcoding, and HLS delivery.
- Video bytes must not be buffered through the existing Express image-upload
  middleware.
- The scope now also includes uploaded Product Videos displayed alongside a
  product's images.
- Reels may contain portrait or landscape media and have a maximum duration of
  90 seconds. Reel presentation remains vertically swiped regardless of the
  source video's orientation.
- PetYard's existing product Favorites support both guest and authenticated
  identities. Video saves reuse those two identity modes, but remain a separate
  domain and are not merged when a guest signs in.

## Accepted language

The canonical product terms are also recorded in `CONTEXT.md`.

- **Video**: PetYard's editorial content record, independent of playback source.
- **YouTube Video**: A Video whose media is hosted and played by YouTube.
- **Reel**: A short-form Video whose media is uploaded by PetYard and delivered
  through the selected video host.
- **Video Asset**: The uploaded source and playable derivatives belonging to a
  Reel.
- **Video Save**: A guest's or account user's decision to retain a Video for
  later viewing.

## Additional language pending architecture decisions

- **Processing State**: Whether a Video Asset is awaiting upload, processing,
  ready, or failed.
- **Publication State**: Whether a Video is visible to its intended audience.

## Decision log

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| Q1 | Canonical product and domain names | Accepted | Overall feature: Videos. Content types: YouTube Video and Reel. Backend values: `youtube` and `reel`. |
| Q2 | Mobile information architecture | Accepted | One Videos tab containing a conventional YouTube Videos section and a reels-style section. |
| Q3 | Viewer access | Accepted | Published content is available to guests and authenticated users. Administration and upload require authentication. |
| Q4 | Admin and super-admin authority | Accepted | Admins with `VIDEOS` can create, upload, edit, preview, and arrange drafts. Their work requires super-admin approval. Super-admin-created YouTube Videos publish after validation, and super-admin-created Reels publish automatically when their Video Asset becomes ready. Only super admins approve, publish, unpublish, and permanently delete. |
| Q5 | MVP engagement capabilities | Accepted with change | Include playback controls, native sharing, saves, and viewing analytics. Defer likes, comments, and follows. |
| Q6 | Initial Reel media constraints | Superseded by Q42 | The earlier 60-second, vertical-only rule no longer applies. |
| Q7 | Feed ordering | Accepted | Super admins control public ordering. Explicitly positioned content comes first; content without a position follows newest-published-first. |
| Q8 | Localization and subtitles | Accepted | Video media has no subtitle track. `title_en` and `title_ar` are required; `description_en` and `description_ar` are optional. Public responses use the existing language-selection behavior. |
| Q9 | Reel hosting | Accepted | Use a dedicated Bunny Stream Video Library. Clients upload directly to Bunny; Bunny provides transcoding and HLS delivery; PetYard owns editorial records, access, feeds, lifecycle, and saves. |
| Q10 | Save identities | Accepted | Both guests and authenticated users can save Videos. Guest saves and account saves remain separate; no merge-on-login behavior is added. |
| Q11 | Save scope | Accepted | Both YouTube Videos and Reels can be saved. Video Saves are separate from commerce Favorites, and add/remove operations are idempotent. |
| Q12 | Unavailable saved content | Accepted | Unpublished Videos are hidden from Saved Videos while retaining the association. Republished Videos reappear. Permanent deletion removes their save associations. |
| Q13 | Ordering authority | Accepted | Admins with `VIDEOS` prepare content, but only super admins change public ordering. Positioned content sorts first by position; unpositioned content follows by newest publication. |
| Q14 | Publication timing | Accepted | Publication and unpublication are manual in MVP. There is no scheduling or automatic expiry. |
| Q15 | Moderation | Accepted | MVP moderation is admin submission followed by super-admin approval. Super-admin-authored content bypasses review and publishes once its technical prerequisites pass. There is no automated content moderation. |
| Q16 | YouTube URL boundary | Accepted | Accept supported `watch`, `youtu.be`, and `shorts` URLs that identify one embeddable video. Store the canonical YouTube video ID. Reject playlists, channels, private videos, live streams, and videos with embedding disabled. YouTube-hosted content always remains a YouTube Video, never a Reel. |
| Q17 | Reel playback security | Accepted | Issue short-lived path-style HLS tokens from PetYard and refresh them when needed. Do not bind tokens to IP addresses because mobile networks change addresses. |
| Q18 | Original retention | Accepted | Delete the original Reel source after successful transcoding. Re-encoding requires a new upload. |
| Q19 | MP4 fallback | Accepted | Do not generate MP4 fallback renditions in MVP. Flutter playback uses adaptive HLS. |
| Q20 | Reel replacement | Accepted | A replacement creates a separate Video Asset. The currently published asset remains active until the replacement is ready and approved, then the active asset switches atomically. A super-admin replacement switches automatically when ready. |
| Q21 | Cover images | Accepted | Provider thumbnails are the default. Admins may upload an optional custom portrait Cover Image for either content type using PetYard's existing Bunny image pipeline. |
| Q22 | Processing failure | Accepted | Failed assets remain unpublished, expose a safe admin-facing reason, and allow reconciliation/retry or a new upload. Failed assets can never be approved or published. |
| Q23 | Separate lifecycles | Accepted | Publication uses `draft`, `in_review`, `approved`, `published`, and `unpublished`. Reel Asset processing separately uses `awaiting_upload`, `processing`, `ready`, and `failed`. Deletion is a separate asynchronous terminal workflow. |
| Q24 | Ordering namespaces | Accepted | YouTube Videos and Reels are ordered independently. In each section, positioned items come first and unpositioned items follow newest-published-first. |
| Q25 | Saved Videos presentation | Accepted | Open a Saved Videos view from the Videos tab. It contains both content types, offers All/YouTube Videos/Reels filters, and sorts newest-saved-first. |
| Q26 | MVP analytics | Accepted | Collect impressions, playback starts, two-second qualified views, 25/50/75 percent progress, completions, watch time, replays, shares, saves/removals, playback errors, and rebuffering. Aggregates are admin-only; there are no public counts or personalization. |
| Q42 | Revised Reel duration and orientation | Accepted | Reels may be portrait or landscape, remain presented in a vertically swiped Reel experience, and are limited to 90 seconds. Rendering is settled by Q71. |
| Q43 | Product Video media limits | Accepted | Product Videos use the same MVP upload policy as Reels: MP4 or MOV, at most 250 MB, and at most 90 seconds. The shared limit keeps provider validation, moderation, and upload behavior consistent; a future change may raise only the Product Video duration. |
| Q44 | Product gallery ordering | Accepted with change | The public `media` projection always contains the product's images first in their existing order, followed by its eligible Product Videos. Exact image/video interleaving is not supported. Ordering Product Videos among themselves remains to be settled. |
| Q45 | Product Video count | Accepted | A product may have at most three active Product Videos. Replacement assets still processing do not consume an additional active slot. |
| Q46 | Product Video reuse clarification | Superseded by Q73 | “Use in reels” means project the Product Video into the reels-style feed without another upload. It does not mean share its Video Asset with a Reel record. |
| Q47 | Product Video feed exposure | Accepted | Eligible Product Videos are projected automatically into the reels-style feed and can be selected through its Product Videos or All filters. They do not become Reel records. |
| Q48 | Product Video editing authority | Accepted | Adding, replacing, or removing Product Videos is part of product editing and does not use the Reel approval workflow. Existing product-media permissions remain unchanged: super admins and admins with `PRODUCTS` may edit them; moderators remain stock-only. |
| Q49 | Product Video metadata | Accepted | A Product Video has no independent title or description. Its feed entry resolves the owning product's live localized titles. |
| Q50 | Product-gallery saves | Accepted | Product galleries expose playback but no Video Save action. Product Favorites remain separate, and Product Video Feed Entries are not saveable. |
| Q51 | Moderator authority | Accepted | Keep current product permissions unchanged. Moderators remain restricted to assigned-warehouse stock and cannot add, replace, or remove Product Videos. |
| Q52 | Cross-product reuse | Accepted | A Product Video and its Video Asset belong to exactly one product in MVP and cannot be attached to another product or Reel. Feed projection reuses the existing Product Video without creating another asset. |
| Q53 | Product-only ownership | Clarified by Q73 | A product upload creates a Video Asset and Product Video Placement but no canonical Video or Reel record. Its reels-style appearance is a response projection of that placement. |
| Q54 | Product gallery ordering controls | Accepted | There is no drag-and-drop or reorder operation for product images or videos. Existing image array order is preserved; Product Videos follow images in the order they were uploaded or selected. |
| Q55 | Product Video Feed Entry titles | Accepted | A Product Video Feed Entry uses the product's live localized titles, so product-title changes appear automatically without synchronizing another editorial record. |
| Q56 | Default short-video feed | Accepted | The reels-style section defaults to explicit Reels. It offers Reels, Product Videos, and All filters; the exact endpoint vocabulary and All-feed duplicate behavior remain to be settled. |
| Q57 | Product Video Feed Entry title overrides | Accepted | Feed-entry titles are read-only because they are resolved from the product's English and Arabic titles. Real Reels remain separate uploads with their own editable titles. |
| Q58 | Inactive product behavior | Accepted | When a product becomes inactive, hide its Product Videos and Product Video Feed Entries from public views without deleting them. Restore them when the product becomes active. Out-of-stock products remain eligible. |
| Q59 | Short-video feed route | Accepted | Use `GET /api/v1/videos/feed?kind=reel|product|all`, defaulting to `kind=reel`. |
| Q60 | All-feed duplicates | Superseded by Q73 | Real Reels and Product Videos never share a Video Asset or editorial record, so `kind=all` returns the union without cross-type asset deduplication. |
| Q61 | Product-feed ordering | Accepted | `kind=product` orders entries by newest Product Video attachment first. Product-gallery insertion order applies only within one product. |
| Q62 | Product-feed saves | Accepted | Product-only feed entries are not saveable. Feed items expose a computed `canSave` boolean so Flutter can show or hide the Save control. A returned Reel or YouTube Video is saveable; a Product Video is not. |
| Q63 | Upload-workflow separation | Superseded by Q73 | Product Videos are uploaded only through product create/edit with `PRODUCTS` authority. Real Reels are uploaded only through Videos administration with `VIDEOS` authority and retain their existing approval rules. There is no Product Video-to-Reel promotion action. |
| Q64 | Product Video replacement | Clarified by Q73 | Replacing a Product Video prepares a new asset while the old one remains active. Once Bunny confirms the replacement is ready, the product gallery and its Product Video Feed Entry switch together to the new asset. |
| Q65 | Product deletion dependency | Accepted | Permanently deleting a product removes its Product Video placements and Product Video Feed Entries. They must no longer appear in any public feed. Their assets follow the reference-aware cleanup rule in Q67. |
| Q66 | Product Video removal dependency | Accepted | Removing a Product Video placement also removes its product-sourced reels-style entry. It is not an independent piece of editorial content after its source placement ceases to exist. |
| Q67 | Provider asset cleanup | Accepted | Delete a Bunny Video Asset only when no Product Video, Reel, active replacement, or pending cutover references it. Provider deletion is asynchronous and retryable, never part of the synchronous product request. |
| Q68 | All-feed ordering | Accepted | `kind=all` is newest-first using Reel publication time or Product Video attachment time. Manual Reel positions apply only to `kind=reel`. |
| Q69 | Feed pagination consistency | Accepted | Reuse PetYard's established `page`/`limit` list contract and return `{ totalResults, totalPages, page, results, data }`. Do not introduce Videos-only cursor pagination. |
| Q70 | Inactive product detail | Accepted | Anonymous/customer product detail must return not-found for inactive products. Authorized product administration may still retrieve them. |
| Q71 | Video aspect-ratio rendering | Accepted | Product and reels-style players preserve the entire source using contain/letterboxing on a neutral background. They never crop or upscale beyond the available rendition. |
| Q72 | Playback behavior | Accepted | Product galleries show a poster and require tap-to-play inline; they do not autoplay and pause when left, with play/pause, seek, mute, and fullscreen. Reels-style feeds autoplay only the centered item, pause all others, preserve mute preference, and expose play/pause, mute, and progress controls. |
| Q73 | Real Reel versus Product Video feed projection | Accepted | Real Reels are uploaded manually only through Videos administration. Product Videos are uploaded only through product create/edit and automatically projected into the reels-style feed when eligible; they never create or share media with a Reel record. A visibility control may suppress that feed projection. Product replacement switches both gallery and feed projection only after Bunny confirms the new asset is ready. |
| Q74 | Product Video feed-visibility field | Accepted | Each Product Video placement has `showInReelsFeed`, defaulting to `true`. It controls only reels-style feed projection, not product-gallery playback. |
| Q75 | Feed-visibility authority | Accepted | Super admins and admins with `PRODUCTS` may change `showInReelsFeed` through product create/edit without separate approval. Moderators remain stock-only. |
| Q76 | Default feed filter | Accepted with recommendation rejected | `GET /api/v1/videos/feed` defaults to `kind=reel`, not `kind=all`. Product Videos remain available through explicit Product Videos and All filters. |
| Q77 | Feed-visibility behavior | Accepted | Setting `showInReelsFeed=false` immediately removes the entry from `kind=product` and `kind=all` while preserving product-gallery playback. Setting it back to `true` restores the entry when the product is active and its asset is ready. |
| Q78 | Feed item discriminator | Accepted | Every feed item has `kind: "reel" | "product"`. Reel items return `canSave: true`; Product Video entries return `canSave: false` plus `productId` and `productHref`. |
| Q79 | Product-create upload sequence | Accepted | Product creation remains the existing product/images multipart request. Only when the admin selected videos does the frontend, after receiving the new product ID, request Product Video upload sessions and upload directly to Bunny through TUS. Image-only creation follows the current flow unchanged. Video failures never roll back the created product; videos remain unavailable until Bunny confirms readiness, and selection order—not upload completion order—determines gallery order. |
| Q80 | Batch upload-session creation | Accepted | After product creation, submit all selected Product Video metadata in one batch request. The backend validates the three-video limit and reserves selection order before returning up to three TUS sessions. |
| Q81 | Pending admin entries | Accepted | Product administration may show `awaiting_upload`, `processing`, `ready`, and transient failure/cleanup status. Only `ready` Product Videos appear in public product media or feeds. |
| Q82 | TUS authorization lifetime | Accepted | Product Video and Reel TUS authorization expires after six hours. |
| Q83 | Abandoned-upload cleanup | Accepted | An incomplete `awaiting_upload` entry becomes abandoned after 24 hours. PetYard releases its reserved slot and asynchronously removes any unused Bunny resource while retaining only a safe audit record. |
| Q84 | Upload concurrency | Accepted | The admin frontend uploads at most two video files concurrently. TUS provides interruption/resume within the valid upload window. |
| Q85 | Slot reservation and terminal cleanup | Accepted | `awaiting_upload`, `processing`, and `ready` Product Videos consume the three-video capacity; failed, abandoned, and replacement assets do not. A recoverable transport interruption remains resumable. Once failure is terminal, remove the failed Product Video/asset from the product, release its slot, and enqueue idempotent Bunny deletion until any provider trace is removed. Retain only non-media audit/cleanup state. |
| Q86 | Batch reservation failure | Accepted | Product Video batch setup is all-or-nothing from the frontend's perspective. If any Bunny/session setup fails before uploads begin, return no usable sessions, remove the PetYard entries, and asynchronously delete every provider resource already created for that batch. |
| Q87 | Active upload failure isolation | Accepted | After a batch is successfully issued, each upload proceeds independently. A terminal failure cleans only that Product Video; other uploads continue processing. |
| Q88 | Explicit upload cancellation | Accepted | Cancellation is terminal: stop TUS, remove the pending Product Video, release its slot, and enqueue provider cleanup immediately. It is not resumable. |
| Q89 | Failure audit retention | Accepted | Retain a sanitized Product Video upload-attempt record for 30 days with product, actor, safe filename, timestamps, stage, and safe failure reason. Never retain bytes, API keys, signed URLs, or reusable upload credentials. |
| Q90 | Retry ordering | Accepted | Retrying a recorded failed attempt reuses its original product-video selection position. A later unrelated upload appends after existing Product Videos. |
| Q91 | Product-edit integration | Accepted | Keep the existing product PATCH for ordinary product/image changes. The edit UI conditionally calls dedicated Product Video endpoints only for add, replace, remove, or `showInReelsFeed` changes. |
| Q92 | Product Video replacement cutover | Accepted | The old video remains playable in its position and keeps its feed-visibility behavior while a replacement processes. A ready replacement atomically inherits the position and `showInReelsFeed`; terminal replacement failure cleans only the new asset and leaves the old video unchanged. |
| Q93 | Product Video removal acceptance | Accepted with change | Record a durable deletion intent, send the Bunny delete request, and remove the Product Video from product media/feed only after Bunny confirms it accepted the deletion. If Bunny rejects the request, keep the Product Video attached and publicly available and expose a safe admin error. Unknown/time-out and already-missing semantics remain to be settled. |
| Q94 | Product deletion with active video work | Accepted | Product deletion cancels/tombstones active Product Videos, removes public exposure, and persists provider-cleanup jobs containing the required identifiers before the product document is removed. Cleanup continues independently afterward. |
| Q95 | Product editing during video processing | Accepted | Ordinary product fields remain editable while videos upload/process. Pending videos may be cancelled; each Product Video may have at most one pending replacement; new videos may be added only while reserved capacity is below three. |
| Q96 | Explicit Bunny deletion outcomes | Accepted | For one Product Video: `2xx` removes locally; `404` is idempotent success and removes locally; `400/401/403` preserves the video with a safe admin error; `429/5xx` preserves it and retries; timeout/unknown preserves it until a Bunny GET confirms absence or a retried delete succeeds. |
| Q97 | Whole-product deletion exception | Accepted | After durable cleanup jobs capture all provider identifiers, whole-product deletion proceeds locally even when Bunny is unavailable. Cleanup retries independently until every provider resource is removed. |
| Q98 | Deleting-state presentation | Accepted | During explicit deletion, the admin UI shows the Product Video as `Deleting...` and disables replacement, visibility mutation, and repeated deletion. It remains publicly available until Bunny returns `2xx` or absence is confirmed, then disappears immediately. |
| Q99 | Background provider-operation execution | Accepted | Persist every asynchronous or retryable Bunny reconcile and cleanup obligation as a durable MongoDB Video Provider Operation. BullMQ is the primary fast execution mechanism, using the operation ID as its idempotent job identity. A lightweight MongoDB sweeper recovers pending or expired-leased work when enqueueing, Redis, or a worker failed. A BullMQ job is never the sole evidence that provider work remains. Request-coupled upload-session creation remains synchronous and persists compensating cleanup before returning failure. |
| Q100 | Persistence boundaries | Accepted | Use separate `Video`, `VideoAsset`, `ProductVideo`, `VideoSave`, `VideoProviderOperation`, and `VideoUploadAttempt` collections because their ownership, lifecycle, and retention rules differ. |
| Q101 | Product Video persistence | Accepted | Store Product Videos in their own collection rather than embedding them in Product. Each has a stable ID, `productId`, immutable selection position, `showInReelsFeed`, active asset, optional pending replacement, and lifecycle timestamps. |
| Q102 | Video Asset ownership | Accepted | Every Video Asset has exactly one `ownerType` (`reel` or `product_video`) and `ownerId`, plus a unique Bunny GUID and verified technical/processing metadata. Cross-owner asset sharing is prohibited. |
| Q103 | MongoDB transaction boundaries | Accepted | Use transactions for multi-record local mutations including reservations, asset/placement creation, replacement cutover, deletion intent plus operation, and whole-product cleanup preparation. Never hold a transaction open during Bunny or Redis calls. |
| Q104 | Upload-session critical path | Accepted | Initial Bunny resource creation and TUS authorization stay synchronous in the upload-session request. BullMQ performs compensation and recovery; the API never waits for a worker to manufacture upload credentials. |
| Q105 | Dedicated video queue | Accepted | Use a dedicated `video-provider` BullMQ queue and worker, initially supporting reconcile, delete, abandoned-upload cleanup, and unknown-deletion verification jobs. Do not reuse the notification queue. |
| Q106 | Queue payload boundary | Accepted | BullMQ jobs contain only the durable operation ID. Workers load authoritative state from MongoDB; jobs contain no keys, signed URLs, upload authorization, filenames, or raw provider responses. |
| Q107 | Deterministic job identity | Accepted | Use the Video Provider Operation ID as BullMQ `jobId`, while retaining an atomic MongoDB lease as the correctness boundary against duplicate or concurrent execution. |
| Q108 | Redis and enqueue failure | Accepted | Once required work commits in MongoDB, enqueue failure never discards or rolls it back. Record the safe failure and let the sweeper recover it; request responses continue to follow their already accepted operation-specific semantics. |
| Q109 | Provider-operation retries | Accepted | Use exponential backoff with jitter, capped at 24 hours. After 10 failures mark `needs_attention`, expose monitoring and immediate super-admin retry, but continue one automatic retry per day until resolved. This is not terminal dead-lettering. |
| Q110 | Video worker concurrency | Accepted | Start the dedicated worker at concurrency three, allow one active lease per operation and no concurrent operations against one Bunny GUID, and expose bounded validated environment configuration. |
| Q111 | Webhook and reconciliation | Accepted | Treat validated Bunny webhooks as fast hints: deduplicate, persist a reconciliation operation, enqueue its ID, and respond quickly. The worker fetches authoritative Bunny state. A sweeper also reconciles assets stuck awaiting upload or processing. |
| Q112 | Monotonic provider state | Accepted | Technical transitions move forward from `awaiting_upload` to `processing` to `ready` or `failed`. Delayed events cannot regress ready assets or revive terminal cleanup state. |
| Q113 | Operation retention | Accepted | TTL-delete completed Video Provider Operations after 90 days and sanitized Video Upload Attempts after 30 days. Keep unresolved and `needs_attention` operations until resolved. Store no credentials or raw provider bodies. |
| Q114 | Videos module boundary | Accepted | The Videos module owns Product Video application logic, Video Assets, Video Provider Operations, the dedicated queue/worker, and one Bunny adapter. Product controllers/services call the Product Video application service and never call Bunny or BullMQ directly. |
| Q115 | Public editorial routes | Accepted | `GET /api/v1/videos/youtube` lists published YouTube Videos; `GET /api/v1/videos/feed?kind=reel|product|all` serves the reels-style feed; `GET /api/v1/videos/:id` returns a public YouTube Video or Reel detail. Product Video Feed Entries are projections, not editorial Video details. |
| Q116 | Product Video route ownership | Accepted | Product Video upload and editing operations are nested under `/api/v1/products/:productId/videos`; public playback grants use a stable Product Video ID. |
| Q117 | Saved Videos route identity | Accepted | `/api/v1/videos/saved` uses the existing bearer-token-or-`x-guest-id` identity middleware for both guests and account users. The route is shared, but the stored identities remain separate with no merge. |
| Q118 | YouTube public response | Accepted | Return the canonical YouTube ID and a backend-constructed `embedUrl`. Never instruct Flutter to load the administrator's original unvalidated URL. |
| Q119 | Editorial administration routes | Accepted | `/api/v1/videos/admin` owns editorial Video create/list/edit and explicit submit, approve, reject, publish, and unpublish actions. Product Video edits remain product-owned and never enter editorial approval. |
| Q120 | Playback grant routes | Accepted | Use `GET /api/v1/videos/:id/playback` for Reels and `GET /api/v1/product-videos/:id/playback` for Product Videos. Each rechecks current public eligibility and returns `{ url, expiresAt }`; YouTube Videos have no playback-grant endpoint. |
| Q121 | Upload-session idempotency | Accepted | Require `Idempotency-Key` for Product Video batch sessions, Reel sessions, and replacement sessions. Identical retries return the existing valid session or current state; the same key with different input returns `409`. |
| Q122 | Admin upload-status recovery | Accepted | Expose status for each upload/replacement so admin UI refresh can recover `awaiting_upload`, `processing`, `ready`, or safe failure state. TUS byte completion alone never implies ready/publication. |
| Q123 | Reviewed edit isolation | Accepted | An admin's title, description, cover, or Reel-asset edit to an approved/published Video becomes a pending reviewed change. The current public version remains visible until a super admin approves the change, then it switches; no unreviewed edit changes public content. |
| Q124 | Saved Videos pagination | Accepted | Saved Videos uses the same `page`/`limit` response shape as the feed. Pagination and totals include only currently visible saved Videos, while associations to unpublished Videos are retained for later reappearance. |
| Q125 | Client-facing error contract | Accepted | Use `404` for unavailable public content, `403` for insufficient staff permission, `409` for conflicting state/idempotency/capacity, `422` for invalid media metadata, and `503` when an upload session cannot safely be issued. Return safe machine-readable error codes, not message-text contracts. |
| Q126 | Analytics trust | Accepted | Flutter-reported playback events are approximate product analytics, deduplicated and rate-limited; client-reported watch time is never billing or security authority. |
| Q127 | Analytics retention | Accepted | Retain raw playback events for 30 days and daily aggregates for 12 months. Do not expose public view counts. Provider operations and upload attempts retain their separately accepted 90/30-day policies. |
| Q128 | Independent feature enablement | Accepted | Use independent switches for editorial Videos public visibility, Reel uploads, and Product Video uploads. Disabling uploads rejects new sessions but does not hide already published/playable videos. Exact flag names and interactions remain to be settled. |
| Q129 | Atomic review of admin edits | Accepted | A pending admin change to a published Video is reviewed as one unit: metadata, cover, and optional Reel replacement switch together only when approved. The current public version remains intact meanwhile. |
| Q130 | Rejected edit recovery | Accepted | Rejection records a safe reason, leaves the admin's proposed change editable for revision/resubmission, and keeps any older published version public. |
| Q131 | Super-admin edit authority | Accepted | A super admin's metadata/cover edit takes effect after validation; their Reel replacement switches when Bunny verifies the new asset ready, without a second approval. |
| Q132 | Reel approval readiness | Accepted | A new or replacement Reel must be Bunny-verified ready and previewable before a super admin can approve it. |
| Q133 | Product Video batch descriptors | Accepted | Each selected file sends a frontend-generated `clientId`, filename, MIME type, byte size, and initial `showInReelsFeed`. The response echoes `clientId` with Product Video ID, reserved position, TUS instructions, and expiry so upload completion order cannot confuse identity. |
| Q134 | TUS authorization refresh | Accepted | Before the 24-hour abandonment deadline, expired six-hour upload authorization should be refreshed for the same Product Video slot and Bunny video rather than creating another placement/upload. Provider-side upload-resource expiry or non-resumability still needs an explicit recovery rule and canary verification. |
| Q135 | Save mutation routes | Accepted | Use idempotent `PUT /api/v1/videos/saved/:videoId` and `DELETE /api/v1/videos/saved/:videoId`, alongside `GET /api/v1/videos/saved`. Product Video IDs are not saveable. |
| Q136 | Personalized saved state | Accepted | Public Video responses return `isSaved` for a valid supplied account or guest identity and `false` otherwise. Compute it outside shared caches. |
| Q137 | Product Video public canary switch | Accepted | Add a separate Product Video public-visibility switch so uploads can be tested privately before product `media` and `kind=product|all` expose them. Disabling an upload switch alone still does not hide existing playable media. |
| Q138 | Cache invalidation | Accepted | After committed readiness, replacement, product activation, feed-visibility, publication, or deletion changes, invalidate affected product detail and Videos feed caches. Do not put signed HLS URLs or identity-specific `isSaved` in shared cache entries. |
| Q139 | Playback analytics ingestion | Accepted | Flutter submits bounded batches of playback events to one ingestion endpoint; event ID plus server-issued playback-session ID support deduplication. Reject unknown types and rate-limit ingestion. |
| Q140 | Analytics dimensions | Accepted | Daily admin-only aggregates group by content identity/type and day, without viewer-level reporting or location tracking in MVP. |
| Q141 | Public release gate | Accepted | Public rollout requires a canary covering portrait and landscape uploads, TUS interruption/resume, Reel approval, Product Video replacement/deletion, missed-webhook reconciliation, signed HLS on Android/iOS, and cleanup-failure recovery; upload success alone is insufficient. |
| Q142 | Unrecoverable TUS resource | Accepted | If fresh authorization cannot resume the existing Bunny upload resource, keep the same Product Video ID, reserved slot, and position; create a replacement Bunny resource for that placement and durably clean up the unusable resource. Provider behavior must be verified in a canary. |
| Q143 | Rejected Reel asset grace | Accepted | Keep a rejected pending Reel-change asset for seven days to allow revision/resubmission, then clean it up if unresolved while retaining editable metadata. Earlier published media remains untouched. |
| Q144 | One pending editorial change | Accepted | Allow only one Pending Video Change per editorial Video. Its author may revise it; simultaneous competing proposals cannot overwrite it. |
| Q145 | Pending change cancellation | Accepted | The author or a super admin may cancel an unapproved change. Keep the existing public version unchanged and durably clean up any replacement asset left unreferenced. |
| Q146 | Approval versus initial publication | Accepted | Approval of a new admin-authored Video moves it to `approved`; a separate super-admin Publish action makes it public. This does not alter the accepted super-admin-authored automatic-publication rule. Approval of a Pending Video Change to an already published Video switches that change into the live version without requiring a second Publish action. |
| Q147 | Protected preview grants | Accepted | Authorized staff may receive short-lived preview grants for ready but unpublished Reels and Product Videos even when public-visibility switches are off. Public playback-grant routes keep returning `404` until eligible. |
| Q148 | Four feature switches | Accepted | Use `VIDEOS_PUBLIC_ENABLED`, `REEL_UPLOADS_ENABLED`, `PRODUCT_VIDEO_UPLOADS_ENABLED`, and `PRODUCT_VIDEOS_PUBLIC_ENABLED`. A disabled public switch returns empty relevant lists and `404` for public detail/playback; protected admin preview remains available. Upload switches only stop new sessions, not already playable media. |
| Q149 | Public response identity | Accepted | Editorial DTOs have stable `id`, localized title/description, cover, `kind`, `canSave`, and `isSaved`. Reels add `playbackHref`; YouTube Videos add `youtubeId` and `embedUrl`. Product feed entries use Product Video ID, live product title, `productId`/`productHref`, and `canSave: false`. |
| Q150 | YouTube analytics honesty | Accepted | Attempt granular YouTube playback metrics only through a verified Flutter WebView/IFrame Player bridge. If callbacks are unavailable or unreliable, mark playback metrics unavailable rather than inferring them from opening the screen. |
| Q151 | New saves for unavailable content | Accepted | A new save request for an unpublished or deleted editorial Video returns `404`. An existing association for an unpublished Video remains hidden and reappears after republication. |
| Q152 | Product list payload size | Accepted | Keep product lists, cards, and search suggestions image-only in MVP. Add derived `media` to product detail responses only. |
| Q153 | Pending Product Video administration | Accepted | Expose pending upload/replacement status through protected product-video administration responses, not public `media`. Public `media` includes only the current ready active asset. |
| Q154 | Later YouTube unavailability | Accepted | A once-valid YouTube Video that later becomes private or non-embeddable produces a safe player error and an admin alert. Do not auto-unpublish after one possibly transient failure; a super admin may confirm and unpublish it. |
| Q155 | Independently filtered mixed feed | Accepted | `kind=all` returns the union of only the Reel and Product Video types whose respective public-visibility switches are enabled; turning off one type does not suppress the other. |
| Q156 | Upload switch during active session | Accepted | Turning off a Reel or Product Video upload switch blocks new upload/replacement reservations. Already-issued TUS sessions may finish, process, and refresh authorization within their existing 24-hour window; the switch does not cancel them. |
| Q157 | Already-issued playback URLs | Accepted | Unpublish, accepted deletion, and disabled public flags block new playback grants immediately. A previously issued signed HLS URL may remain usable until its token expires or Bunny removes the asset. Use a maximum 15-minute token lifetime in MVP and verify the bound during the canary; no per-video instant revocation is promised. |
| Q158 | Fail-closed feature configuration | Accepted | All four feature switches default false. Enabling a feature without its required Bunny secrets/configuration fails startup validation; PetYard never falls back to unsigned HLS playback. |
| Q159 | Unpublish during pending review | Accepted | If a published Video is unpublished while an admin change awaits review, approving that change may update the approved content but must not republish it; a separate super-admin Publish action is required. |
| Q160 | Rejected replacement grace on resubmission | Accepted (2026-10-01) | Editing a rejected proposal does not extend its original seven-day asset-retention deadline. Resubmission stops rejected-asset cleanup while the proposal is under review; another rejection starts a new seven-day period. |
| Q161 | Private draft arrangement | Accepted (2026-10-01) | Store a separate `draftPosition`, used only in a filtered admin draft list. Apply the existing draft-edit permissions and independent YouTube/Reel ordering. Approval and publication never copy draft positions into public positions. |
| Q162 | Permanent editorial deletion | Accepted (2026-10-01) | A super admin may permanently delete an editorial YouTube Video or Reel in any lifecycle state. Once the transaction removes the Video and saves and records independent cleanup obligations, it disappears locally even if Bunny or Redis is unavailable. Cleanup remains asynchronous and retryable; failed upload sessions retain markers for late-create compensation and unknown-GUID recovery. This does not change Q93/Q96 individual Product Video removal, which waits for provider acceptance or confirmed absence. |

## Accepted MVP scope

- The mobile app has one Videos tab with two sections. YouTube Videos use a
  conventional browsing and embedded-player experience. Reels use vertical
  swipe navigation.
- Published Videos are publicly viewable by guests and authenticated users.
- Admins with the Videos control prepare content. Super admins control approval,
  publication, unpublication, permanent deletion, and manual ordering.
- Users can save Videos in the first release. Likes and comments are explicitly
  outside the first release.
- Both guests and account users can save either content type. Their saves remain
  separate, and Video Saves do not share storage with product Favorites.
- Reels are at most 90 seconds and may use portrait or landscape media while
  remaining part of the vertically swiped Reel experience. The existing 250 MB
  and MP4/MOV decisions remain in force unless revised later.
- Product Videos use the same MP4/MOV, 250 MB, and 90-second MVP limits as
  Reels.
- Each product may have at most three active Product Videos. Product `media`
  returns existing images first, followed by eligible Product Videos.
- Product-only videos have no title or description and are edited through the
  product workflow without super-admin video approval. Existing product
  permissions remain unchanged, so moderators are stock-only and cannot edit
  Product Videos.
- A Product Video belongs to one product. It creates a Video Asset and Product
  Video Placement but no canonical Video or Reel record. Its reels-style item
  is a projection of the placement.
- Product media has no reorder operation: images retain existing array order,
  then videos follow in upload/selection order.
- Image-only product creation uses the existing multipart request unchanged.
  When videos were selected, their direct Bunny upload phase begins only after
  that request returns the new product ID. Video failure cannot roll back the
  product.
- Product Video session metadata is created in one batch, selection order is
  reserved before upload, and the browser uploads no more than two videos at a
  time. Upload authorization lasts six hours.
- Live awaiting-upload, processing, and ready entries reserve the three Product
  Video slots. Abandoned uploads expire after 24 hours. Terminal failures are
  removed from the product and cleaned from Bunny asynchronously and
  idempotently; resumable network interruptions are not terminal failures.
- Batch setup is all-or-nothing before upload begins, while issued uploads fail
  independently. Cancellation is terminal. Sanitized failure audits remain for
  30 days, and a direct retry preserves its original selection position.
- Product edit keeps its ordinary PATCH and invokes separate video operations
  only when needed. Replacement preserves the old video until ready. Explicit
  removal keeps the video attached until Bunny confirms deletion acceptance.
- Product deletion first persists independent cleanup jobs for all video work,
  allowing provider cleanup to continue after the product document is gone.
- Explicit Product Video deletion treats Bunny `404` as idempotent success,
  preserves the video on rejected/transient/unknown requests, and reconciles
  uncertain results. Whole-product deletion remains non-blocking once durable
  cleanup jobs exist.
- The Reels feed defaults to explicit Reels and supports Reels, Product Videos,
  and All filters.
- Product Video placements default `showInReelsFeed` to `true`. Authorized
  product editors may toggle it without affecting product-gallery playback.
- Feed responses discriminate entries with `kind: "reel" | "product"`.
  Product entries include `productId`, `productHref`, and `canSave: false`.
- The short-video feed is `GET /api/v1/videos/feed` with `kind=reel`,
  `kind=product`, or `kind=all`. It unions independent real Reels and eligible
  Product Video projections; there is no cross-type asset deduplication.
- Product-only feed entries return `canSave: false`; Reel and YouTube Video
  entries return `canSave: true` when presented in save-capable video views.
- Product Video Feed Entry titles are read-only and resolve from the product.
  Inactive products hide both gallery videos and feed projections; zero stock
  alone does not.
- Deleting a product or removing its Product Video removes the corresponding
  product-sourced reels-style entry. Bunny media is deleted only after no
  remaining Product Video, Reel, replacement, or cutover reference exists.
- Product and feed players preserve the whole source without cropping. Product
  galleries require tap-to-play; reels-style feeds autoplay only the centered
  item and preserve the user's mute preference.
- Super admins can assign ordering. When ordering is absent, the public fallback
  is newest published content first.
- Timed subtitles are outside the first release.
- Both editorial titles are required; localized descriptions are optional.
- Bunny Stream handles Reel ingestion, transcoding, and HLS delivery through a
  dedicated library. PetYard does not operate its own transcoding/CDN pipeline.
- Publication and moderation are manual. Scheduling, expiry, and automated
  moderation are outside the first release.
- Super-admin-authored content automatically publishes after its source is
  validated or its Reel asset becomes ready. Admin-authored content requires
  super-admin approval.
- Reel playback uses short-lived path-tokenized HLS without IP binding. MP4
  fallback and retained originals are disabled in MVP.
- Replacing a Reel never interrupts its active published asset. A replacement
  asset is prepared separately and becomes active only after it is ready and
  has the required approval.
- Provider thumbnails are used by default, with optional custom portrait Cover
  Images stored through the existing Bunny image pipeline.
- Saved Videos is a mixed, filterable view ordered by save time.
- MVP analytics are collected for playback quality and engagement, exposed only
  as admin aggregates, and do not personalize ranking.
- Uploaded Product Videos appear alongside product images and use the same Bunny
  Stream delivery foundation as Reels.

## Explicitly not yet decided

- Environment-variable wiring. The production Bunny library, encoding profile,
  storage region, High Volume delivery tier, native-HLS security toggles, and
  six-hour TUS authorization lifetime are settled in
  `BUNNY_STREAM_CONFIGURATION_PLAN.md`.
- Exact engineering schemas, indexes, route payloads, and analytics event limits
  are to be specified from the accepted behavior, then reviewed for consistency.
- Bunny TUS expiry/replacement behavior and Android/iOS playback require canary
  verification; accepted recovery behavior is not a claim of provider proof.
- Implementation tickets, code/tests, encrypted secret handoff, and rollout
  remain to be completed after user confirmation.

## YouTube player-error reporting details — accepted 2026-10-02

The user approved the V6.07 proposal: users and guests report failures through
`protectUserOrGuest`, only for published YouTube Videos; reasons are bounded
and allowlisted, with rate limiting and no raw client errors/URLs/reporter
identity retained in alerts. Recipients are active super admins and active
admins with `VIDEOS` permission. Alert identity is the Video/current YouTube
ID/recipient/UTC day, not the reporting identity or reason. There is no
automatic unpublication. The user also approved the Public Videos service and
reporting HTTP route as test seams with fake external database/notification
adapters. Exact implemented request/response and live gates are in
`VIDEOS_API_CONTRACT_PLAN.md` and `VIDEOS_TODO.md`; this is not rollout approval.

## Analytics session contract — accepted 2026-10-02

The user approved all six V8.01 session choices and test seams: one
identity-protected session endpoint for all three content kinds, opaque
30-minute sessions bound to the caller and current media, fresh eligibility
checks during ingestion, private transient session identity, Cairo daily
reporting buckets, and service/HTTP tests with fake external adapters and a
controlled clock. Existing HLS GET responses remain unchanged. This is not
live acceptance or permission to enable flags. Details are in
`VIDEOS_API_CONTRACT_PLAN.md`.

## Analytics ingestion limits — accepted 2026-10-02

The user approved all five V8.01 ingestion choices: batches of 1–50 events,
a 64 KiB logical JSON bound, allowlisted types, five-minute past/30-second
future timestamp limits, atomic acceptance with exact-retry deduplication and
changed-payload conflicts, a 500-event session ceiling, and per-process IP
limits of 120 session requests/60 ingestion requests per minute. Qualified
views derive from watch time, while saves derive from committed save endpoint
mutations. Existing global limits also apply. Exact metric semantics are not
implied by this approval; see the separate V8.03 proposal in the API contract.

## Analytics metric semantics — accepted 2026-10-02

The user approved all seven V8.03 metric choices: a fresh session per actual
replay; semantic once-per-session impression/start/view/milestone/completion/
replay counts; bounded foreground visible non-overlapping watch intervals;
server-duration progress and 95%-watched end-callback completion; bounded
share/error/rebuffer events; honest YouTube capability/duration gating; and
save-transition counting. Full fields, timing and exceptions are in
`VIDEOS_API_CONTRACT_PLAN.md`. This approves behavior and the already accepted
test seams, not live writes or rollout. Session issuance/resolution and the
basic-event ingestion foundation and uploaded native playback calculations
and committed-save recording are implemented locally. Aggregates and reports remain.

## Analytics basic-event implementation boundary — 2026-10-02

V8.02.2a accepts impressions, shares and bounded playback errors through the
atomic batch path. Its partial scope does not change the accepted eventual
metric rules: native playback event types return an explicit unavailable error
until their processing is implemented. Exact normalized retries bypass the
new-event age/chronology checks but still require valid current sessions/media.
Raw event expiry is requested 30 days after server receipt; real index/TTL and
Mongo transaction behavior remain separate acceptance gates. Default-off
rollout and the later enum/FE-document sequencing are unchanged.

## Uploaded playback metric implementation boundary — 2026-10-02

V8.02.2b/V8.03.1 extends the same atomic ingestion path with starts, replay,
bounded watched intervals, one derived qualified view, server-duration
milestones/completion and post-start buffering. YouTube granular metrics remain
explicitly unavailable. Watches and buffering cannot overlap; watches cannot
predate a reported actual start. Absent start telemetry does not itself prevent
valid watch admission. FE remains responsible for accurate foreground/visible
timing, actual end callbacks, stable episode/event IDs and fresh replay sessions.
No client duration, arbitrary metadata, viewer history, new public count or
report was added. Save-transition recording and aggregates remain pending.

## Committed save analytics implementation boundary — 2026-10-02

V8.03.2 records a private server-generated event only when the public save
endpoint actually adds or removes a saved state, in the same database
transaction. Retry/no-op requests and automatic permanent-deletion cleanup do
not count as customer actions. Re-saving after a real removal is a new addition.
Hidden saves stay removable; Product Videos remain unsaveable, and user/guest
identities are not merged. No playback session or client save telemetry is
required or accepted. Analytics storage failure aborts the save change and
returns a safe retryable error. Daily aggregation/reporting and real Mongo
acceptance remain separate; rollout flags and FE request/response fields stay
unchanged.

## Daily analytics and report boundary — accepted and implemented locally 2026-10-02

The user approved V8.04: daily totals commit with raw events/save state rather
than through a new queue; Cairo/DST watch intervals split at local midnight;
twelve-calendar-month retention uses explicit expiry and TTL; history survives
content deletion. Staff reports reuse `protect`, admin/super-admin roles and
the existing `ANALYTICS` control. One daily endpoint accepts kind, optional
content ID and an inclusive Cairo date range, defaulting to thirty dates and
bounded to 366, with existing Videos pagination. No viewer/location reports or
public counts are added. Unavailable YouTube playback metrics are `null`.

Implementation uses the existing transaction fences and installed Luxon; the
analytics service/HTTP test boundaries remain approved. Local tests and real
Mongoose casting do not prove real Mongo indexes, TTL or concurrent retries.
Aggregation is prospective; no earlier raw-event backfill or rollout occurred.
Full contract and proof are in `VIDEOS_API_CONTRACT_PLAN.md` and the checklist.

## Current proposals awaiting acceptance
- Complete the encrypted-secret handoff in
  `BUNNY_STREAM_CONFIGURATION_PLAN.md`. The production library has been
  created and its non-secret cost, encoding, storage, and security settings
  were verified on 2026-09-16; no API or token key was revealed, copied, or
  rotated.
- Use Frankfurt as the only Bunny Stream storage region for the cost-first MVP.
  Do not retain the default Singapore, Los Angeles, or New York replicas; the
  library creation screen showed four selected regions at `$0.03/GB`. The live
  account then showed Frankfurt alone, with no Geo replication, at `$0.00/GB`
  in the creation-screen pricing overview; each optional replica displayed an
  additional `$0.01/GB`.
