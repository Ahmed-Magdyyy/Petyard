# PetYard Videos HTTP Contract Plan

Status: Product behavior accepted through Q162. The concrete JSON examples and
write-route spellings below are engineering drafts for final review, not yet
implementation authority. See
`VIDEOS_FEATURE_DECISIONS.md` for the decision log.

## Current backend architecture and authentication

Videos now follows PetYard's route/controller/service/repository responsibilities
within its existing subfolders. HTTP handlers are in controllers, input checks in
validators, and upload guards/parser configuration in middleware. The former
application files are services; dependency injection is retained for tests.
The refactor does not change endpoint paths or response shapes.

Provider queries and transactional writes belong to repositories. Services own
provider calls, queue dispatch and Product cache invalidation. Cleanup operation
IDs returned by repositories are internal committed-write details, not additions
to HTTP responses. Admin/public pagination shares one validator; Reel readiness
shares one policy. Upload grants use the validated configured lifetime, still
bounded by the persisted resource expiration and original abandonment deadline.

Staff routes use the existing `protect`, role and enabled-control middleware;
review/publication/permanent-deletion/public-position actions remain super-admin-only. Private draft
arrangement uses the existing draft-edit permissions. Public Videos and
Product Video playback use `optionalProtect`: anonymous reads are allowed, but
invalid supplied bearer tokens return 401. Saves use `protectUserOrGuest`,
preserving separate authenticated-user and `x-guest-id` identities. Upload gates
remain after authorization and before parsing/handler execution.

## Provider operation administration implementation boundary

Implemented locally under V2.07. Both global monitoring and immediate retry are
super-admin-only, as confirmed on 2026-10-02. The routes use the existing
`protect`, role and control middleware, and services repeat the super-admin guard
for internal callers. Admins with `VIDEOS`, moderators, users and guests cannot
access global provider-operation data. Public/upload switches do not block
monitoring or recovery of existing obligations.

- `GET /api/v1/videos/admin/provider-operations`: accepts only `page`, `limit`,
  optional `status` and optional `type`. Pagination defaults to page 1/limit 20,
  with limit at most 100. Status values are `pending`, `running`,
  `needs_attention`, `completed`; type values are `reconcile`, `copy_poster`,
  `delete`, `abandoned_upload_cleanup`, `verify_deletion`, `cover_cleanup`.
  Omitted filters include all values. Sort by newest creation, then descending
  operation ID for ties. Returns `200 { data: { totalResults, totalPages, page,
  results, data: Operation[] } }`, using the existing Videos page convention.
- `POST /api/v1/videos/admin/provider-operations/:operationId/retry`: accepts
  a MongoDB ObjectId path and no body fields (an empty JSON object is allowed).
  Only a `needs_attention` operation can atomically become `pending` and due now.
  Failure counts and previous provider-error history are preserved. Returns
  `202 { data: { operation: Operation, queued: boolean } }`. This is acceptance
  of background work, not proof that processing succeeded. No synchronous Bunny
  call, force-completion or lease bypass occurs.

Both responses set `Cache-Control: private, no-store`. `Operation` contains only
`id`, `type`, `status`, `failedAttempts`, `createdAt`, `updatedAt`, `nextAttemptAt`,
`leaseExpiresAt`, `completedAt`, `lastErrorAt`, `lastEnqueueErrorAt`,
`lastErrorCode` and `lastEnqueueErrorCode`. Missing optional values are null.
`leaseExpiresAt` is a safe monitoring timestamp, not a lease token or identity.
Error codes are bounded sanitized identifiers; unexpected stored codes become
`PROVIDER_ERROR`. Provider GUIDs, asset/cover/storage identifiers, dedupe keys,
lease tokens, active-target keys, credentials and raw provider responses are
never returned. Responses describe a snapshot; worker execution can change the
state immediately afterward. App timestamp formatting remains unchanged.

Persistence precedes enqueueing. Redis failure returns accepted work with
`queued: false`, leaves the operation due for the existing sweeper, and attempts
to record the safe `QUEUE_ERROR` code. Failure to record that queue diagnostic
does not undo the already committed retry. Database failure before the transition
returns sanitized `503 VIDEO_OPERATION_UNAVAILABLE`; nothing is enqueued.

Unknown operations return `404 VIDEO_OPERATION_NOT_FOUND`; pending, running or
completed operations return `409 VIDEO_OPERATION_STATE_CONFLICT`. Concurrent
retry requests permit one transition; a losing request returns 409 (or 404 if
the record is no longer present). Invalid filters, IDs or body fields return
`422 VIDEO_OPERATION_INVALID_INPUT`; page/limit range errors retain
`422 VIDEO_INVALID_PAGINATION`. Existing authentication errors remain 401/403.
No new dependency/environment variable was added. Real MongoDB/Redis/worker
acceptance and the admin frontend remain separate gates.

## Bunny Stream webhook implementation boundary

Locally implemented: `POST /api/v1/integrations/bunny-stream/webhook`. This is a
server-to-server endpoint, not a Flutter/admin API. It authenticates the signed
body rather than a user JWT, using the existing `BUNNY_STREAM_READ_ONLY_API_KEY`.
No new environment variable is required. Production dashboard configuration and
real database/worker acceptance are still pending.

Require uncompressed `application/json`, at most 16 KiB, and these headers:

- `X-BunnyStream-Signature-Version: v1`
- `X-BunnyStream-Signature-Algorithm: hmac-sha256`
- `X-BunnyStream-Signature`: 64 lowercase hexadecimal characters, representing
  HMAC-SHA256 of the exact raw body bytes using the library Read-Only API key.

Body fields are `VideoLibraryId` (positive safe integer matching the configured
library), `VideoGuid` (UUID string) and `Status` (integer 0–10). Status is only a
notification hint, never proof of readiness, deletion or publication. The worker
fetches authoritative Bunny state before applying its existing guarded updates.
This follows [Bunny's signed webhook protocol](https://bunny.net/docs/stream/webhooks).

Authenticated valid requests return `202 { "received": true }` with
`Cache-Control: private, no-store`. Unknown, foreign or deleting/deleted targets
are ignored with the same acknowledgement. For known active targets, the durable
operation is recorded before queue dispatch; Redis failure does not prevent 202
because the existing sweeper can recover the work. Persistence/configuration
failure returns `503 VIDEO_WEBHOOK_UNAVAILABLE` instead of acknowledging lost work.

Signature failures return `401 VIDEO_WEBHOOK_INVALID_SIGNATURE`; invalid payload
fields/JSON return `422 VIDEO_WEBHOOK_INVALID_PAYLOAD`; library mismatch returns
`422 VIDEO_WEBHOOK_WRONG_LIBRARY`. HTTP content-type/compression/parser failures
use `VIDEO_WEBHOOK_INVALID_BODY` with 400, 413 or 415 as appropriate. Oversize input
rejected directly through the service uses `413 VIDEO_WEBHOOK_TOO_LARGE`.

Exact byte-replays reuse an operation keyed by library and raw-body SHA256 for its
retention period (currently 90 days after completion). Completed operations are
not re-enqueued. Signed JSON with different whitespace/key order can create a
separate reconciliation hint. The v1 protocol signs no timestamp/event ID, so no
freshness guarantee is claimed. Visibility/upload flags do not block validated
hints for existing assets; this endpoint never opens an upload/publication gate.

## Custom cover implementation boundary

Custom cover storage, attachment, review and projection are implemented locally.
New cover uploads remain hard-off in production pending real-system acceptance.
The store reuses Bunny public image storage
for single-frame portrait JPEG/PNG/WebP files, up to 5 MiB and 16 megapixels,
checking orientation after EXIF rotation. It preserves portrait aspect ratio
without cropping and converts to WebP within 1080 by 1920 pixels.

Internal cover-generation persistence and cleanup are now implemented locally.
The generation and non-secret storage identity are recorded before PUT; failures
and expired unattached generations create durable image-only `cover_cleanup`
operations on the existing queue. Cleanup checks both current and pending Video
references and never assumes that an uncertain upload has finished. Such work
remains retryable/needs-attention. Super-admin monitoring and immediate retry are
now implemented under V2.07; these do not force settlement or bypass the need
for authoritative evidence about an unknown upload outcome.

Protected endpoints, under the existing admin/super-admin and `VIDEOS` control:

- `POST /api/v1/videos/admin/:id/cover`: multipart body with exactly one file,
  named `cover`, and no text fields. Returns `200 { data: Video }`. Missing input
  is `422 VIDEO_INVALID_COVER`; multipart size/count/field errors use the existing
  `400` upload error convention. Decoded-image validation also returns `422`.
  A default hard-off readiness guard returns `503 VIDEO_COVER_DISABLED` before
  parsing multipart data. Changing an environment flag does not open this route.
- `DELETE /api/v1/videos/admin/:id/cover`: no body fields. Returns
  `200 { data: Video }`; invalid fields return `422 VIDEO_INVALID_COVER`. Removal
  and cancellation remain usable for existing generations with uploads closed.

Both responses are `private, no-store`. Upload creates a fresh server-owned
generation; clients cannot submit a cover URL or identifier through metadata
PATCH. Draft edits attach directly, except in-review content is locked and admins
cannot edit super-admin automatic drafts. Admin edits to approved/published/
unpublished content change only the author's pending proposal, preserving any
pending replacement upload and rejected-asset deadline. Submit/reject/approve
and whole-proposal cancellation use the existing editorial actions. Super-admin
edits apply immediately only when no competing proposal exists; edits to their
own automatic replacement synchronize both versions to prevent later reversion.

Attachment, cover promotion/removal and old-cover cleanup intent/operation share
the owning Video revision transaction. Approval can promote metadata, a cover and
replacement Stream media together without changing publication state. Cleanup
never retires a cover still referenced by active or pending content. Expiring a
rejected replacement's Stream media does not remove its retained cover proposal.

Protected detail and cover-edit responses add `coverUrl` (nullable), and
`pendingChange.coverUrl` when a proposal exists. These URLs are derived from
owned, attached, settled, non-deleting cover records, not client input. The admin
list is not enriched with these URLs; use protected detail when reviewing covers.
Public lists/detail/saves expose only the active `coverUrl`, with a YouTube
thumbnail or the copied Reel poster as fallback. Pending cover metadata, object
keys and provider identities remain private. Product Video posters are unchanged.

No new environment variable or dependency was added. Local fake-adapter tests
prove the implemented isolation, rollback and projection branches, not real
Mongo transaction/index behavior, Bunny delivery or worker restart. Those gates
and explicit rollout approval remain pending. Any future reference writer must
update the non-deleting cover and Video in one transaction; a reference-only
write would break cleanup fencing.

## Public reading

- `GET /api/v1/videos/youtube`: published YouTube Videos in their independent
  section and ordering namespace.
- `GET /api/v1/videos/feed?kind=reel|product|all`: reels-style feed, default
  `kind=reel`. Product entries are projections, not editorial Videos.
- `GET /api/v1/videos/:id`: published YouTube Video or Reel detail only.
- `GET /api/v1/videos/:id/playback`: short-lived HLS grant for an eligible Reel.
- `GET /api/v1/product-videos/:id/playback`: short-lived HLS grant for an
  eligible Product Video. Product visibility, placement, and active ready asset
  are rechecked at grant time.

The two playback grants return `{ "url": "...", "expiresAt": "..." }` and
never expose a long-lived signed playlist in list/detail responses. YouTube
Videos do not have a PetYard playback-grant route. Their public DTO includes
the canonical YouTube ID and an `embedUrl` constructed by PetYard, rather than
the original administrator-submitted URL.

Editorial public DTOs use stable `id`, localized `title` and `description`,
cover, `kind`, `canSave`, and `isSaved`. Reel items add `playbackHref`; YouTube
items add `youtubeId` and `embedUrl`. Product feed entries use the stable
Product Video ID, the owning product's live localized title,
`productId`/`productHref`, and `canSave: false`. Product lists, cards, and
search suggestions remain image-only; product detail alone adds `media`.

Public list and Saved Videos pagination follow the established `page`/`limit`
contract with `{ totalResults, totalPages, page, results, data }`. Saved totals
include only currently visible Videos; associations to unpublished Videos are
retained so they can reappear after publication.

When a public-visibility switch is off, its relevant list returns an empty
page, while individual public detail and playback grants return `404`.
`kind=all` independently filters Reels and Product Video Feed Entries by their
respective public switches, so one enabled type remains available if the other
is disabled.
Protected staff preview may still be used for ready but unpublished media.

## Saves

`/api/v1/videos/saved` serves guest and authenticated account identities
through the existing bearer-token-or-`x-guest-id` middleware. The route may be
shared, but identities and persisted saves remain separate; logging in never
merges guest saves. Only editorial YouTube Videos and Reels are saveable.

Use `GET /api/v1/videos/saved`, idempotent
`PUT /api/v1/videos/saved/:videoId`, and idempotent
`DELETE /api/v1/videos/saved/:videoId`. Product Video IDs cannot be saved.
Public Video DTOs return `isSaved` for the supplied valid account/guest identity
and `false` when no identity is supplied. Resolve that field outside shared
response caches. New save requests for unpublished or deleted Videos return
`404`; earlier saves of unpublished Videos remain stored but hidden.

## Product Video administration

Product Video upload and edit operations are nested under
`/api/v1/products/:productId/videos` and retain current product-media
permission rules: super admins and admins with `PRODUCTS`; moderators remain
stock-only. A status read lets the administration UI recover pending and
replacement uploads after refresh. Product Video edits never use editorial
Video approval.

### Protected Product Video preview (local implementation)

`GET /api/v1/products/:productId/videos/:videoId/preview?asset=active|pending`
uses the same product permissions as the write routes; `asset` defaults to
`active`. Super admins and admins with `PRODUCTS` can preview current ready
media even when upload/public flags are off or the product is inactive.
A deleted product, detached placement, failed/unready asset, or wrong provider
ownership is not previewable. `pending` selects only the placement's exact
issued replacement; it is not an arbitrary asset-ID input.

The server probes signed HLS and then rechecks the product/placement/asset
generation. Success is `200 { data: { url, expiresAt } }` with
`Cache-Control: private, no-store`, a maximum 15-minute lifetime, and no provider
metadata or upload credentials. An active asset remains previewable during
pending explicit deletion until Stream acceptance, matching public deletion
semantics. Pending replacements cannot be previewed once cancellation,
adoption or deletion supersedes them.

Invalid IDs/selection return `422 VIDEO_INVALID_PREVIEW`; unavailable media
returns `404 VIDEO_PREVIEW_NOT_AVAILABLE`; a missing playable playlist returns
`409 VIDEO_PREVIEW_NOT_READY`; a generation change during the probe returns
`409 VIDEO_PREVIEW_CHANGED`. Missing Stream configuration returns
`503 VIDEO_PREVIEW_UNAVAILABLE`. Provider/network failures do not yield a grant.
These are local tests, not live database/provider/device acceptance.

Product Video batch upload sessions, Reel upload sessions, and replacement
sessions require `Idempotency-Key`. An identical retry returns its existing
valid session or current state; a conflicting payload with the same key returns
`409`. TUS byte completion means submitted, not provider-verified ready.

Each Product Video batch descriptor contains frontend `clientId`, filename,
MIME type, byte size, and initial `showInReelsFeed`. Each response entry echoes
`clientId` together with its stable Product Video ID, reserved position, TUS
instructions, and authorization expiry. Before 24-hour abandonment, an expired
six-hour authorization is refreshed for the same placement and Bunny video
where the provider upload resource remains live. Bunny documents that
re-signing does not extend the resource's original expiry and that an expired
incomplete resource returns `404`. If it cannot resume, create a replacement
Bunny resource for the same placement and durably clean up the old one; verify
the behavior in the provider canary.

If Bunny cannot resume even with fresh authorization, preserve the Product
Video ID, slot, and gallery position while creating a replacement Bunny
resource for that placement. Persist cleanup of the unusable provider resource.
This is a required fallback, not a claim that Bunny has already been verified
to support every version of the flow.

Pending Product Video upload/replacement states are exposed in protected
administration responses, never in public `media`; public product media shows
only the currently ready active asset.

## Editorial administration

`/api/v1/videos/admin` owns editorial Video creation, listing, editing, and
explicit submit, approve, reject, publish, and unpublish actions. A pending
admin edit to an approved or published Video remains isolated from the public
version until super-admin approval. This includes metadata, cover, and Reel
asset replacement. Product Video operations are excluded from this workflow.

The currently implemented local V5 slices use these protected routes:

| Method/path | Request | Result |
| --- | --- | --- |
| `POST /api/v1/videos/admin` | YouTube: `{ kind?: "youtube", youtubeUrl, title_en, title_ar, description_en?, description_ar? }`; Reel metadata: `{ kind: "reel", title_en, title_ar, description_en?, description_ar? }` | `201 { data: Video }`; YouTube follows existing publication rules; Reel remains draft until a separate upload is ready |
| `GET /api/v1/videos/admin?page=1&limit=20` | Pagination (`limit` at most 100); optional paired `kind=youtube` or `reel` and `status=draft` | `200 { data: { totalResults, totalPages, page, results, data } }`; paired filters select the privately arranged draft section |
| `GET /api/v1/videos/admin/:id` | None | Protected Video including pending change |
| `GET /api/v1/videos/admin/:id/preview?asset=active\|pending` | Selection defaults to active | Staff with `VIDEOS` only; ready Reel with current issued asset returns `200 { data: { url, expiresAt } }` and `Cache-Control: private, no-store`; unavailable media returns `404`, unplayable signed HLS returns `409` |
| `PATCH /api/v1/videos/admin/:id` | One or more title/description fields; `youtubeUrl` is YouTube-only | Updated draft, direct super-admin edit, or isolated Pending Video Change; Reel asset/cover fields are not accepted |
| `POST /api/v1/videos/admin/:id/submit` | None | Admin draft or own Pending Video Change enters review |
| `POST /api/v1/videos/admin/:id/approve` | None | Super-admin approval; new Video remains hidden until Publish |
| `POST /api/v1/videos/admin/:id/reject` | `{ reason }` | Super-admin rejection with editable draft/change |
| `POST /api/v1/videos/admin/:id/publish` | None | Super-admin publication after fresh YouTube verification |
| `POST /api/v1/videos/admin/:id/unpublish` | None | Super-admin public removal, retaining current content |
| `PATCH /api/v1/videos/admin/:id/position` | `{ position: non-negative safe integer | null }` | Super-admin ordering of one published YouTube Video or editorial Reel; `null` restores newest-first fallback |
| `PATCH /api/v1/videos/admin/positions` | `{ kind: "youtube" or "reel", items: [{ videoId, revision, position }] }` | Super-admin atomic ordering of 1–100 published Videos in one section; returns committed positions and new revisions |
| `PATCH /api/v1/videos/admin/:id/draft-position` | `{ draftPosition: non-negative safe integer or null, revision }` | Admin with `VIDEOS` or super admin; existing draft-edit rules apply; returns committed private draft position and revision |
| `POST /api/v1/videos/admin/:id/upload-session` | `Idempotency-Key`; `{ file: { filename, mimeType, sizeBytes } }` | Reel-only TUS session or `202` reserving status; production remains disabled until worker/recovery gates pass |
| `GET /api/v1/videos/admin/:id/upload-session` | None | Author or super-admin upload status; no credentials/provider identifiers; works while new uploads are disabled |
| `POST /api/v1/videos/admin/:id/upload-sessions/:sessionId/authorization` | None | Author or super-admin refresh of that exact current issued generation, without creating a resource |
| `POST /api/v1/videos/admin/:id/upload-sessions/:sessionId/recovery` | `Idempotency-Key`; `{ file: { filename, mimeType, sizeBytes } }` | Explicit non-resumable initial upload recovery; `202` waiting for verified cleanup, then same-key retry `201` with a new resource and unchanged session/deadline |
| `DELETE /api/v1/videos/admin/:id/upload-sessions/:sessionId` | None | Author or super-admin terminal cancellation of an unfinished initial upload; `202` after durable cleanup intent |
| `POST /api/v1/videos/admin/:id/replacement-upload-session` | `Idempotency-Key`; `{ file: { filename, mimeType, sizeBytes } }` | Separate pending Reel upload; `201` issued or `202` reserving; production creation remains hard-off |
| `GET /api/v1/videos/admin/:id/replacement-upload-session` | None | Own replacement status for admins; super admins may inspect any; same safe status DTO as initial uploads |
| `POST /api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId/authorization` | None | Refresh that exact pending issued generation without creating a resource |
| `POST /api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId/recovery` | `Idempotency-Key`; `{ file: { filename, mimeType, sizeBytes } }` | Equivalent pending upload recovery; published media, proposal metadata and review authority remain unchanged |
| `DELETE /api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId` | None | Author or super-admin cancellation and durable cleanup of pending media, including ready media; `202` |
| `DELETE /api/v1/videos/admin/:id/pending-change` | None | Author or super-admin whole-proposal cancellation; `200 { data: Video }` with null pending change and private/no-store; attached replacement cleanup is durable, current content stays unchanged |

This is a local backend slice, not a public release contract. Real-system Reel
upload-lifetime, review, deletion and cover acceptance remain unfinished.

### Permanent editorial deletion (V5.14, implemented locally)

`DELETE /api/v1/videos/admin/:id` uses the existing `protect`, role/control and
super-admin-only middleware. Admins cannot delete even their own drafts. The
body must contain exactly the current protected Video revision:

```json
{ "revision": 3 }
```

The ID must be a 24-character hexadecimal ObjectId; revision must be a
non-negative safe integer. No client-supplied provider ID, asset ID or cover
reference is accepted. Success is `202`, with `Cache-Control: private, no-store`:

```json
{ "data": { "videoId": "507f1f77bcf86cd799439011", "status": "removed" } }
```

`removed` means the editorial record and its user/guest saves have been removed
locally, not that Bunny cleanup has finished. All lifecycle states are eligible.
An already-absent valid ID returns the same acknowledgement, with a valid body
still required. A stale revision or inconsistent media ownership/reference
returns `409 VIDEO_STATE_CONFLICT`; malformed input returns
`422 VIDEO_INVALID_DELETE`. Authentication and authorization run before action
validation. Existing upload and public-visibility switches do not block removal.

One transaction removes the owner and all saves, marks its active, pending and
detached owned media for deletion, records durable cleanup operations, and fails
reserving/issued upload sessions. It preserves independent assets, covers and
session markers so cleanup and late provider compensation do not need the
deleted owner. Persistence failure rolls back removal. Redis failure after
commit does not restore the Video; the existing worker/sweeper retries cleanup.
Save and cover reservation coordinate with deletion through a private owner
write fence, without changing editorial revisions or exposing that counter.

New public reads, saves, previews and upload grants cannot find the removed
owner. Previously issued HLS URLs still follow Q157; immediate CDN revocation
is not promised. Unknown-GUID positive orphan recovery is not enabled by this
endpoint and remains the V5.15 gate. Individual Product Video deletion retains
its different provider-acceptance rule under Q93/Q96.

### Single-item public positions (V5.13.1, implemented locally)

The position PATCH accepts exactly `{ "position": 0 }` or another non-negative
safe integer, or `{ "position": null }` to clear manual ordering. The action is
super-admin-only and applies only to published editorial YouTube Videos/Reels.
Admins cannot change public positions, even with the `VIDEOS` control. Existing
authorization rules exempt super admins from the per-admin control list.
Product Video projections, drafts, in-review, approved and unpublished content
are not valid targets. Malformed bodies return `422 VIDEO_INVALID_POSITION`;
unavailable targets return `404 VIDEO_NOT_FOUND`; wrong lifecycle or a failed
revision check returns `409 VIDEO_STATE_CONFLICT`.

YouTube and Reel positions are independent. In `kind=reel`, positioned Reels
sort first by ascending position, then newest publication and ID descending;
missing/null positions follow newest-published-first. Equal positions are
allowed and use the same deterministic tie-breakers; this action does not shift
other items. `kind=all` remains newest-first and ignores manual Reel positions.
Product-only feeds/gallery order and save-time ordering are unchanged.

A position change updates the existing Video revision, not pending metadata,
cover, upload session, active media or publication state. It is immediate and
does not require content review. Reviewed and automatic replacements preserve
the latest position; a concurrent position change invalidates a stale cutover
revision. No provider request or new environment setting is needed. Bulk ordering
uses the separate endpoint below; private draft arrangement has its own field
and endpoint and never changes public positions.

### Private draft arrangement (V5.13.3, implemented locally)

Use `GET /api/v1/videos/admin?kind=youtube&status=draft&page=1&limit=20`,
or `kind=reel`, to list one draft section. Both filters must be supplied together;
unsupported kinds/statuses or malformed filter values return
`422 VIDEO_INVALID_FILTER`. Omitting both filters preserves the original mixed
staff list and its newest-created-first order. The response keeps the existing
pagination shape and is `private, no-store`.

Within each filtered section, explicit `draftPosition` values sort first in
ascending order. Equal positions use newest creation time, then ID descending;
missing/null positions follow with the same newest-first fallback. The arrangement
is shared staff data, not an individual admin preference. Only initial Videos
with `status: "draft"` participate; Pending Video Changes on existing content
are not separate arrangement targets.

To set or clear one draft position, send:

```http
PATCH /api/v1/videos/admin/507f1f77bcf86cd799439011/draft-position
Content-Type: application/json
```

```json
{ "draftPosition": 0, "revision": 3 }
```

The body accepts exactly these two fields. `draftPosition` is a non-negative
safe integer or `null` to restore fallback. `revision` is the current revision
from protected list/detail, a non-negative safe integer below JavaScript's maximum
safe integer. Success returns `200` with `Cache-Control: private, no-store`:

```json
{
  "data": {
    "videoId": "507f1f77bcf86cd799439011",
    "draftPosition": 0,
    "revision": 4
  }
}
```

Existing `protect`, staff roles and `VIDEOS` control checks apply. The service
reuses the existing draft-edit rules: admins can arrange editable shared drafts,
but cannot arrange super-admin automatic Reel drafts. Super admins retain their
existing editing authority. This action does not grant public-order authority to
admins or permit edits to in-review/approved/published/unpublished content.
Conflicting pending changes retain the existing edit restriction.

Malformed bodies return `422 VIDEO_INVALID_POSITION`; missing/invalid IDs return
`404 VIDEO_NOT_FOUND`; non-draft or stale revisions return
`409 VIDEO_STATE_CONFLICT`; denied editing authority returns `403 VIDEO_FORBIDDEN`.
The conditional write changes only `draftPosition` and increments the shared Video
revision, fencing concurrent submission/edit/publication. Equal positions are
allowed; omitted Videos are never shifted. Refresh protected records after a
conflict. Metadata PATCH cannot write either ordering field.

The optional field needs no backfill: existing records remain unpositioned.
Draft positions may remain stored after review/publication but are never copied
to `position`, consulted by public queries or included in public DTOs. Product
gallery/feed order and saves are unchanged. No provider/queue call, new setting or
automatic promotion is added. Local fake-database checks are not real MongoDB or
dashboard frontend acceptance.

### Atomic bulk public positions (V5.13.2, implemented locally)

`PATCH /api/v1/videos/admin/positions` supports drag ordering without partially
applying a stale batch. Existing staff authentication and role/control middleware
run before validation; only a super admin may perform this action.

```json
{
  "kind": "youtube",
  "items": [
    { "videoId": "507f1f77bcf86cd799439012", "revision": 3, "position": 0 },
    { "videoId": "507f1f77bcf86cd799439011", "revision": 3, "position": 1 }
  ]
}
```

The body accepts only `kind` and `items`. `kind` is `youtube` or `reel`, never
`all` or `product`. Each of the 1–100 entries accepts only `videoId`, `revision`
and `position`. IDs must be distinct ObjectId hex strings; casing is normalized.
Use the latest revision returned by the protected list/detail or a successful
ordering response. Revisions must be non-negative safe integers below JavaScript's
maximum safe integer. Positions are non-negative safe integers or `null`.

All entries must still be published in the requested section and match their
submitted revisions. One MongoDB transaction changes only positions and increments
revisions; pending changes, content and media references remain untouched. A
missing, stale, hidden or wrong-section entry returns `409 VIDEO_STATE_CONFLICT`
and rolls back the entire batch. Malformed input returns
`422 VIDEO_INVALID_POSITION`. These codes are in the existing HTTP `error` array.

Success returns `200` with `Cache-Control: private, no-store`:

```json
{
  "data": {
    "kind": "youtube",
    "items": [
      { "videoId": "507f1f77bcf86cd799439012", "position": 0, "revision": 4 },
      { "videoId": "507f1f77bcf86cd799439011", "position": 1, "revision": 4 }
    ]
  }
}
```

The result follows request order. Partial lists are allowed: omitted Videos are
unchanged, and positions are not shifted automatically. Equal positions retain
the existing deterministic tie-breakers; `null` restores newest-first fallback.
After a conflict, refresh the affected protected records before constructing a
new batch. A batch over 100 items is rejected, not split automatically; separate
requests are separate transactions. Mixed/Product feeds, Product galleries and
saved ordering remain unchanged. No Bunny/Redis call or new setting is required.
Local fake-database tests do not establish real MongoDB concurrency acceptance.

Reel metadata drafts and an isolated upload-session path are now implemented
locally. The production route has an additional hard-off readiness gate even
if `REEL_UPLOADS_ENABLED` is changed; it must not issue Bunny credentials until
worker reconciliation, stale-setup/abandoned-upload recovery, protected
preview verification, and the live MongoDB/CDN canary are wired and tested.
The local protected preview and signed-playlist probe now gate editorial
review/publication and super-admin auto-publication; the route remains hard-off
while recovery and live-provider evidence are incomplete.

### Reel upload recovery for administration

Initial upload creation/replay now includes `sessionId` alongside `videoId`,
`status`, and (only when issued) `upload`. Administration with the existing
`VIDEOS` permission may read/manage its own Reel uploads; super admins may
manage any Reel. The current-status response is:

```json
{
  "data": {
    "videoId": "507f1f77bcf86cd799439011",
    "sessionId": "507f1f77bcf86cd799439012",
    "status": "awaiting_upload",
    "videoStatus": "draft",
    "failureCode": null,
    "canRefresh": true,
    "abandonAt": "2026-10-01T12:00:00.000Z"
  }
}
```

Status is `none` for an untouched draft, `reserving` during setup, or the
verified asset's technical state while current. `ready` requires the existing
validated readiness metadata and does not mean published; `videoStatus`
separately records the editorial workflow. After detachment, the latest
failed/cancelled attempt remains visible. The response does not include Bunny
GUIDs, TUS URLs, authorization headers, or raw provider errors.

Refresh targets the returned session ID and returns
`{ data: { videoId, sessionId, status: "awaiting_upload", upload } }`.
It requires the current issued asset to remain awaiting upload, without
deletion intent, on a draft. Authorization expires at the earliest of six
hours from now, the original TUS resource expiry, and the original 24-hour
abandonment deadline. An expired resource returns
`409 VIDEO_UPLOAD_RESOURCE_EXPIRED`; processing, completed, cancelled, stale,
or abandoned generations return `409 VIDEO_UPLOAD_CONFLICT`. Refresh never
creates or deletes a Bunny video/resource. Non-resumable recovery is implemented
locally through the separate endpoints below; rollout remains disabled.

Cancellation targets one session ID, not whichever upload happens to be
current. It accepts reserving/awaiting/processing or still-attached failed initial uploads on a draft,
not a ready or published asset. The transaction releases the draft's upload,
records a terminal `VIDEO_UPLOAD_CANCELLED` attempt, and persists deletion of
any known GUID. Queue submission follows the commit; Redis failure leaves the
operation recoverable by the existing sweeper. A late setup response still
uses the existing failed-session compensation path. Repeating cancellation
of that cancelled session is harmless and cannot cancel a newer generation.
The response is `{ data: { videoId, sessionId, status: "cancelled" } }`; `202`
does not claim Bunny deletion has completed or revoke a previously issued
TUS token immediately. Actual provider removal follows durable cleanup.

All three recovery responses have `Cache-Control: private, no-store`.
They retain authentication/control checks but do not consult the new-upload
switch or pipeline gate, so existing sessions remain manageable when those
gates close. A missing/wrong-author Reel returns `404 VIDEO_UPLOAD_NOT_FOUND`;
invalid identities return `400 VIDEO_INVALID_MEDIA`.

### Reel non-resumable resource recovery (V5.09.2, implemented locally)

For an existing issued initial or pending replacement session, use the matching
`POST .../upload-sessions/:sessionId/recovery` or
`POST .../replacement-upload-sessions/:sessionId/recovery` route listed above.
Both retain `protect`, staff role and `VIDEOS` control checks. Initial uploads
require their draft author or a super admin; pending uploads require their
session author or a super admin. Existing-session recovery remains available
with both new-upload switches and the Reel pipeline guard off.

Send exactly `{ "file": { "filename": "original.mp4", "mimeType": "video/mp4",
"sizeBytes": 12345678 } }` and a stable recovery `Idempotency-Key` of 8–128
trimmed characters. All three descriptor values must match the issued session.
The usual MP4/MOV validation and 250 MiB declared-size limit apply. No caller
TUS URL, provider identifier, visibility or editorial metadata is accepted.
Use a new recovery key and keep the same key/descriptor for every retry.

Matching management status 0 and a fresh-signed HEAD 404 of the trusted stored
TUS URL, or authoritative management GET 404, permits a transactional recovery
marker and old-generation cleanup. Processing/ready/failure statuses 1–6,
resumable or complete TUS resources, malformed or mismatched observations,
stale bindings, an elapsed original deadline and legacy sessions without a
trusted URL return `409 VIDEO_UPLOAD_CONFLICT`. Observation outages return
sanitized `503 VIDEO_PROVIDER_UNAVAILABLE`. Authentication/control errors retain
401/403; missing/wrong-author initial Videos return `404 VIDEO_UPLOAD_NOT_FOUND`.
Invalid request bodies, descriptors, IDs or keys return `400 VIDEO_INVALID_MEDIA`.

The first accepted request returns `202` with
`{ data: { videoId, sessionId, recoveryId, status: "recovering" } }`, without an
upload URL or credentials. Retry the same route/key/descriptor after cleanup
progresses. New allocation waits for completed durable cleanup: trusted TUS
termination or absence, management GET 404 and poster cleanup. Management DELETE
acceptance alone cannot unlock creation. A queue outage leaves committed work
due for the existing worker sweep.

Once cleanup completes, one retry claims creation and returns `201` with
`{ data: { videoId, sessionId, recoveryId, status: "awaiting_upload", upload } }`.
`upload` keeps the existing instruction shape. The logical session ID stays
unchanged; its current Video Asset and trusted TUS URL change atomically. An
identical issued retry returns the same resource with fresh bounded authorization.
Original creation-key replay also resolves the session's current recovered
resource; it cannot allocate another resource. The client resends the selected
file bytes through HEAD/PATCH to `upload.uploadUrl`, never POST to `upload.endpoint`.
The new resource and grants are capped by the original 24-hour abandonment
deadline and the configured six-hour maximum; recovery never resets the window.

Published active media, position, cover, editorial content, pending proposal
metadata and review/automatic-application authority remain unchanged. Pending
recovery pins the active ready generation through the existing session binding.
Cancellation of the logical upload or whole proposal, permanent owner deletion,
deadline expiry and changed current generations prevent late adoption. Known
late resources enter durable compensating cleanup. Existing cancellation targets
the same logical session, including its current recovered resource; it cannot
cancel a subsequent separately reserved session.

Changed actor/purpose/descriptor on the same key, a different key while recovery
is active, an in-flight creation claim, failed attempts and stale sessions return
`409 VIDEO_UPLOAD_CONFLICT`. Issued replay after resource expiry returns
`409 VIDEO_UPLOAD_RESOURCE_EXPIRED`. A lost setup/commit response returns a safe
503; retry the same key to discover a committed issued result. Failure to persist
known-resource cleanup returns `500 VIDEO_CLEANUP_PERSISTENCE_FAILED`.

Unknown create outcomes retain their generation marker and block blind allocation.
The existing internal orphan inspector accepts an optional recovery ID and checks
its exact marker, library, empty-media state, timestamps and untracked GUID. Cleanup
adoption remains opt-in and unwired in production. Stale creation claims and
expired recovery markers use the existing setup sweep; it never creates resources.
Original-deadline retirement preserves editable pending metadata and old public media.

Both recovery responses are `private, no-store`. Protected upload status optionally
adds `recovery: { id, status, failureCode }` while a marker is attached. Its status
is `waiting_cleanup`, `reserving` or `failed`; it exposes no provider GUID, URL or
credentials, and `canRefresh` is false for the retired old asset. Normal refresh
continues to fail closed and never performs replacement implicitly.

Local proof: 24 new Reel service/HTTP/worker/editorial integration tests, one exact
adapter-marker test and full Videos suite 692/692. Real MongoDB/Bunny/Redis/device
acceptance, unknown unissued TUS POST cleanup and production orphan wiring remain
separate gates. No new live run or enablement is authorized by this implementation.

### Reel metadata editing

The existing PATCH accepts `title_en`, `title_ar`, `description_en` and
`description_ar` for a Reel. It trims text, requires non-empty localized
titles (maximum 160 characters), and limits descriptions to 2,000 characters.
An empty patch or any other field, including YouTube URLs, product IDs,
asset IDs, covers, status and kind, returns `422 VIDEO_INVALID_METADATA`.

Draft metadata can change during upload/processing without changing the
asset, upload session, publication status or automatic-publication authority.
An admin cannot directly edit a super-admin auto-publishing draft
(`403 VIDEO_FORBIDDEN`), because that would publish the admin's edits without
review. Super admins may edit such drafts. Initial in-review Videos remain
locked, as do pending proposals awaiting review.

An admin PATCH to an approved/published/unpublished Reel creates or revises
one Pending Video Change. Current public metadata and the active asset stay
unchanged. Only that proposal's author may revise/submit it; its author or a
super admin may cancel it. Super admins can edit metadata directly only when
there is no pending proposal; they cannot silently overwrite another change.

Reel proposals use the same submit/approve/reject/cancel actions as YouTube
proposals. Submission and approval freshly verify the existing active asset's
protected playback; failed readiness returns `409 VIDEO_ASSET_NOT_READY`.
Rejection preserves the proposal for revision without changing public content.
Approving changes metadata without replacing its video or changing its current
publication state. In particular, approval after unpublish does not republish.
All writes retain the existing revision check and return
`409 VIDEO_STATE_CONFLICT` if the record changed during verification.

Pending content now records its internal `kind` so its schema can validate
Reel metadata without a YouTube ID. Legacy YouTube proposals default to
`youtube` and still require a valid YouTube ID. Public projections continue
to ignore the entire pending proposal. Pending replacement uploads, cutover and
rejected-asset grace/cancellation are implemented as described below;
custom cover review is implemented locally with uploads gated as described above.

### Pending Reel replacement uploads (local foundation; creation hard-off)

Replacement creation applies only to an approved/published/unpublished Reel
with a current ready asset. It uses the initial upload file validation and
response shape (`videoId`, `sessionId`, `status`, and issued `upload`). The
route selects replacement purpose internally; clients cannot select it in the
body. The same key/file/actor reuses its reservation; changed input, a key used
for initial upload, another author's proposal or a competing upload returns
`409 VIDEO_UPLOAD_CONFLICT`. There is one pending proposal, not a second public
Video. Existing editable proposal metadata is preserved.

Status/refresh/cancel use the same safe DTOs and original TUS authorization,
resource-expiry and abandonment bounds as initial uploads, but do not require
the public Video to be a draft. Admins may manage only their own replacement
sessions; super admins may manage any. Wrong session purpose, actor or current
generation fails closed. A successfully applied replacement reports `status:
"applied"` and `canRefresh: false`; the session remains internally issued so
current public media can resolve it. Creation, status, refresh and cancellation responses
are `private, no-store`; recovery routes remain available when new uploads close.

`preview?asset=pending` selects only the current issued replacement, verifies
its ownership/configured library and probes signed playback. Cancellation or
generation change during the probe returns `409 VIDEO_PREVIEW_CHANGED`.
Invalid selection returns `422 VIDEO_INVALID_PREVIEW`. No arbitrary asset ID
is accepted. `asset=active` continues previewing the current public asset.

Cancellation and terminal recovery detach replacement pointers and durably
schedule cleanup of that generation only. Proposal metadata and the active
public asset remain unchanged. An in-review replacement can be cancelled by
its author or a super admin; remaining metadata returns to draft and needs a
fresh submission. Metadata PATCH preserves those pointers. Use session-specific
cancellation to retain the proposed metadata, or whole pending-change cancellation
to discard the entire proposal and durably clean its replacement in one call.

### Reel replacement review and cutover (implemented locally; not enabled)

The existing submit/approve/reject actions now support attached replacement
proposals. Submission checks the admin author and verifies the pending media,
not the active asset. Approval freshly verifies it again and transactionally
rechecks the exact pending session, previous asset, revision, immutable owner,
configured library and ready metadata. Missing/unready/unplayable pending media
returns `409 VIDEO_ASSET_NOT_READY`; a changed generation/revision returns
`409 VIDEO_STATE_CONFLICT`. Metadata and active asset/session switch together;
the current publication state, publication timestamp and position stay unchanged.
Approval after unpublish never republishes. Rejection retains the pending asset
and editable proposal for resubmission, with the seven-day grace below.

Super-admin replacements apply automatically only after verified readiness and
signed preview, using captured immutable session authority and the same atomic
cutover. Transient preview failure defers application to the worker sweep; admin
replacements never use that bypass. An automatic replacement author's direct
super-admin metadata PATCH updates both current metadata and pending content,
so later application does not revert it. Other authors cannot overwrite it.

The cutover transaction persists deletion intent and a durable cleanup operation
for the now-unreferenced old asset before committing. Cleanup persistence failure
prevents the switch. Redis enqueue follows commit; queue failure does not undo
a committed change or lose cleanup. Provider deletion completes asynchronously;
approval success does not claim that the old Bunny object is already gone.
New upload creation stays hard-off and live acceptance is still required.

### Rejected replacement grace and whole-proposal cancellation (local implementation)

Rejecting a pending Reel replacement sets `pendingChange.rejectedAssetExpiresAt`
to seven days after the recorded rejection time. This protected admin date is
not a public field and is not client-editable. Metadata editing does not extend
it. A successful resubmission clears it while the proposal is in review; another
rejection starts a fresh seven-day window (Q160). Failed submission preserves
the deadline. The worker checks due changes in bounded batches, not a new
provider call or delayed queue job per rejection.

Once due and still unresolved in rejected/editable draft state, the worker
transactionally removes only that pending asset/session, retains editable
metadata as draft and persists cleanup of the unused exact GUID. The existing
active media/public metadata never change. Administration of the old attempt
reports `failed` with `VIDEO_REJECTED_ASSET_EXPIRED`; a new upload needs a new
idempotency key. A resubmitted, replaced, cancelled or concurrently changed
generation cannot be cleaned from an old sweep candidate. Legacy rejected
proposals may use a valid `reviewedAt` when their deadline is absent; missing
review dates fail closed and are not guessed.

`DELETE /api/v1/videos/admin/:id/pending-change` accepts no body. It cancels the
current whole proposal for its admin author or any super admin, including
draft/in-review/rejected changes and unissued replacement reservations. The
transaction clears the proposal, terminally fails its replacement session and
persists known-GUID deletion/audit records before responding. Late provider
creation responses still use failed-session compensation. Missing/wrong-owner
sessions or asset/library/generation mismatches return a safe `409` without
discarding media. Missing authority returns `403 VIDEO_FORBIDDEN`.

The response remains `200 { data: Video }`, with `pendingChange: null` and
`Cache-Control: private, no-store`. It does not claim provider deletion has
finished or immediately revoke an existing TUS token. Redis failure after commit
does not lose cleanup. This endpoint does not consult new-upload/public flags.
If the proposal was already applied/cancelled, cancellation returns
`409 VIDEO_STATE_CONFLICT`; it is not a historical session cancellation endpoint.

Treat the pending change as one review unit. Rejection records a safe reason
and leaves it editable for resubmission without disturbing the current public
version. A newly uploaded or replacement Reel must be Bunny-verified ready
and previewable before approval. Super-admin edits to metadata/cover take
effect after validation, while their Reel replacements switch when ready
without another approval.

Only one Pending Video Change may exist per editorial Video. Its author may
revise it, while competing changes cannot overwrite it. Its author or a super
admin may cancel it; the current public version remains unchanged and any
unreferenced replacement asset enters durable cleanup. A rejected pending
Reel asset is retained for seven days for revision/resubmission, then cleaned
up if the proposal remains unresolved while editable metadata stays.

Approval of a *new* admin-authored Video enters `approved`; publication still
needs a distinct super-admin Publish action. Approval of an edit to an
already-published Video switches the reviewed change into the current public
version without another Publish action. Super-admin-authored new Videos keep
the separately accepted automatic-publication behavior.

If the Video is unpublished while a Pending Video Change awaits review,
approving the change does not republish it. The approved content may update,
but a separate super-admin Publish action is required.

The `VIDEOS` admin control is implemented in PetYard's `enabledControls` enum
and applied to editorial routes; it does not grant Product Video permissions.

## Errors and analytics

Return safe machine-readable error codes with HTTP status `404` for
unavailable public content, `403` for insufficient staff authority, `409` for
state/idempotency/capacity conflicts, `422` for invalid media metadata, and
`503` when upload sessions cannot safely be issued.

PetYard currently serializes operational errors as
`{ "status": "fail", "error": [], "message": "..." }`. Videos can preserve
that response envelope and put stable `{ "code": "..." }` objects in its
`error` array. A new top-level `code` field is not required for the accepted
machine-readable contract. Do not make Flutter parse `message`.

Flutter playback events are approximate analytics only. Ingestion is
deduplicated and rate-limited; client watch time is never a billing or
security authority. Raw events expire after 30 days; daily aggregates expire
after 12 months. Public counts are not exposed. The one ingestion endpoint
accepts bounded event batches with event IDs and server-issued playback-session
IDs, rejecting unknown types. Daily aggregates group by content identity/type
and day, without viewer-level reporting or location tracking in MVP.

Google's [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
exposes playback-state events and player-time methods. The Flutter WebView
bridge and its event reliability must be verified before promising the same
granular analytics for YouTube Videos as for native HLS playback.
If the bridge is unreliable or unavailable, mark those YouTube playback
metrics unavailable rather than inferring them from screen opens. A later
YouTube embedding failure shows a safe player error and alerts staff; one
transient failure does not auto-unpublish the editorial Video.

## Staged enablement

Use `VIDEOS_PUBLIC_ENABLED`, `REEL_UPLOADS_ENABLED`,
`PRODUCT_VIDEO_UPLOADS_ENABLED`, and `PRODUCT_VIDEOS_PUBLIC_ENABLED`.
Disabling an upload switch rejects new sessions without hiding already
published/playable media. The two separate public switches allow editorial
Videos and Product Videos to launch independently. Their disabled read behavior
is the empty-list/individual-`404` rule above. Protected admin preview remains
available while public visibility is off.

All four switches default to `false`. Turning off an upload switch blocks new
upload/replacement reservations, but existing TUS sessions may complete,
process, and refresh authorization within their original 24-hour window.
Enabling a feature without the required Bunny secrets/configuration fails
startup validation; unsigned playback is never a fallback.

Unpublishing, accepted deletion, or disabling public visibility blocks new
playback grants immediately. A previously issued HLS URL may continue to work
until its token expires or Bunny removes the asset. MVP tokens expire within
15 minutes; the canary must test this limit. Per-video instant URL revocation
is not part of the MVP contract.

Before public enablement, a real canary must pass portrait and landscape
uploads, TUS interruption/resume, Reel approval, Product Video replacement and
deletion, missed-webhook reconciliation, signed HLS on Android and iOS, and
cleanup-failure recovery. Merely completing an upload is not a release gate.

## Concrete HTTP shapes for final review

These examples specialize the accepted behavior without changing the existing
product `images` field. Lists use the established outer pagination object;
detail and mutation responses follow the repository's `{ data: ... }`
convention except the accepted playback-grant object.

### Published editorial items

```json
{
  "id": "<Video ObjectId>",
  "kind": "youtube",
  "title": "Localized title",
  "description": "Localized description or null",
  "coverUrl": "https://...",
  "youtubeId": "<canonical YouTube ID>",
  "embedUrl": "https://www.youtube.com/embed/<canonical YouTube ID>",
  "canSave": true,
  "isSaved": false,
  "publishedAt": "<ISO timestamp>"
}
```

A Reel uses the same common fields with `kind: "reel"` and replaces
`youtubeId`/`embedUrl` with `playbackHref`, `durationSeconds`, `width`,
`height`, and `aspectRatio`. A Product Video Feed Entry uses the stable
Product Video placement ID, `kind: "product"`, live product title,
`productId`, `productHref`, `playbackHref`, `canSave: false`, and
`isSaved: false`; it does not receive an editorial Video ID.

Public DTOs never expose provider GUID/library ID, original filename,
pending review state, or TUS credentials. Both YouTube and Reel list/detail
reads may accept a bearer token or `x-guest-id` to compute `isSaved` outside
shared caches, without requiring either for viewing.

### Product Video batch upload session

Proposed request to
`POST /api/v1/products/:productId/videos/upload-sessions`:

```json
{
  "files": [
    {
      "clientId": "<frontend UUID>",
      "filename": "demo.mp4",
      "mimeType": "video/mp4",
      "sizeBytes": 12345678,
      "showInReelsFeed": true
    }
  ]
}
```

The request requires `Idempotency-Key` (trimmed 8–128 characters, consistent
with existing PetYard mutations). The response returns a `data` array in
selection order, each with `clientId`, `productVideoId`, reserved video
`position`, `status: "awaiting_upload"`, and `upload` instructions containing
the server-created `uploadUrl`, original `resourceExpiresAt`, ephemeral
authorization headers, and `expiresAt` (Unix seconds). The backend creates the
empty TUS resource using the declared file size/type and persists its exact
validated URL against the Video Asset before returning upload instructions.
The frontend resumes that URL with TUS HEAD/PATCH; **it must not POST another
resource to `endpoint`**. That legacy field remains informational in the
authorization object, not an instruction to create an upload. Clients must
not automatically create another upload if resuming this URL returns 404.
Temporary upload authorization is returned only to authorized administration
clients, never logged or placed in a public Product response. Idempotent
retries may regenerate an unexpired signature for the same Bunny resource.
An issued-batch replay is bounded by the persisted TUS resource's original
expiry, each placement's original 24-hour deadline, and the six-hour
authorization maximum. Refresh/replay reuse the persisted URL without a
provider POST and cannot extend its original expiry. Refresh of an otherwise
current upload whose original TUS resource expiry has passed returns
`409 VIDEO_UPLOAD_RESOURCE_EXPIRED`; it does not allocate or delete media.
Batch replay and no-longer-awaiting assets return `409 VIDEO_UPLOAD_CONFLICT`;
replay does not restart the upload window. The resource-expired code tells
administration clients to request the recovery flow below, await reconciliation
or use explicit cancellation. Clients must not create another Bunny resource.
Disabling new Product Video reservations does not disable authorization
refresh for an already-issued, still-live upload within its original 24-hour
window.

Legacy sessions without a backend-persisted TUS URL return
`409 VIDEO_UPLOAD_CONFLICT` on refresh/replay. They are not silently assigned
a new provider resource or deleted. This rollout remains default-off; any
preexisting test sessions need deliberate reconciliation before enablement.
No route accepts a caller-supplied TUS URL as proof of ownership. The separate
Q142 replacement is implemented locally through the protected recovery endpoints
below; expired-resource conflicts must not trigger a frontend Bunny POST.

If any pre-upload batch setup fails, no usable sessions are returned and every
created provider resource enters durable cleanup. Once sessions are issued,
each upload proceeds independently. Upload-refresh and unrecoverable-resource
fallback preserve the Product Video placement ID and position.

`GET /api/v1/products/:productId/videos` returns protected placement status
in position order. Its `failureCode` is a safe code only, including a rejected
provider deletion; it never contains provider GUIDs or upload credentials.
`DELETE /api/v1/products/:productId/videos/:videoId/upload-session` cancels
only an unfinished upload and returns `202` with
`{ "data": { "productVideoId": "...", "status": "cancelled" } }` after
durable provider cleanup is recorded. The frontend must stop its TUS upload.
`PATCH /api/v1/products/:productId/videos/:videoId` accepts exactly
`{ "showInReelsFeed": true|false }` for a ready, non-replacing Product Video;
it changes feed eligibility without deleting product media.

### Product Video replacement (implemented locally, flags remain off)

`POST /api/v1/products/:productId/videos/:videoId/replacement-upload-session`
requires `Idempotency-Key` and the existing product media-editor permission.
Send one file, without `showInReelsFeed` (replacement preserves visibility):

```json
{
  "file": {
    "clientId": "<frontend UUID>",
    "filename": "replacement.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 12345678
  }
}
```

Success returns `201`:

```json
{
  "data": {
    "productVideoId": "<existing placement ID>",
    "replacementId": "<replacement session ID>",
    "position": 0,
    "clientId": "<frontend UUID>",
    "status": "awaiting_upload",
    "upload": {
      "endpoint": "https://video.bunnycdn.com/tusupload",
      "uploadUrl": "https://video.bunnycdn.com/tusupload/<server-created resource ID>",
      "resourceExpiresAt": 1801000000,
      "expiresAt": 1801000000,
      "headers": {
        "AuthorizationExpire": "1801000000",
        "AuthorizationSignature": "<ephemeral signature>",
        "LibraryId": "<library ID>",
        "VideoId": "<provider video GUID>"
      }
    }
  }
}
```

The expiry above is illustrative (Unix seconds). Replacement refresh/replay
reuse this exact persisted URL and are capped by its original expiry as well
as the original 24-hour replacement window. The client performs HEAD/PATCH
against `uploadUrl`, not POST against `endpoint`.
Position is the existing reserved value.
There is at most one replacement per placement. The active ready video stays
available until provider-verified readiness and an atomic cutover. Failure or
cancellation retains it. Cutover records durable cleanup of the old asset.

An identical request/key reuses the same replacement. Changed payloads or
another key while a replacement is active return `409 VIDEO_UPLOAD_CONFLICT`.
A still-reserving retry also returns that conflict; retry later with the same
key. A processing/ready observation or terminal `completed`, `failed`, or
`cancelled` replay returns status without `upload`; it never creates another
resource. Starting another replacement requires a new key.

- `POST /api/v1/products/:productId/videos/:videoId/replacements/:replacementId/upload-authorization`
  returns `200` with placement/replacement IDs, position, `awaiting_upload`,
  and renewed `upload`. Authorization is bounded by the original 24-hour
  session deadline. It does not restart that deadline or allocate a resource.
  A current but expired TUS resource returns
  `409 VIDEO_UPLOAD_RESOURCE_EXPIRED` without replacing or deleting either
  the pending or old ready Video Asset.
- `DELETE /api/v1/products/:productId/videos/:videoId/replacements/:replacementId/upload-session`
  returns `202` with `{ "data": { "productVideoId": "...", "replacementId": "...", "status": "cancelled" } }`
  after durable cleanup is recorded. The frontend must stop TUS. Repeating a
  cancelled generation is harmless and cannot cancel a subsequent replacement;
  completed/non-current generations cannot be cancelled.

These two issued-session actions remain available when new-upload creation
is disabled. They require normal media-edit authorization. The implemented
worker recovery retires an expired, still-awaiting initial upload or replacement
after authoritative provider absence or a matching management status-0
observation at the original deadline. It checks the original deadline, owner,
library and current asset/generation in the cleanup transaction.
Initial placements disappear from admin status; replacement failure reports
`VIDEO_UPLOAD_ABANDONED` while retaining the old ready video. Processing and
ready assets are not abandoned by this rule. This abandonment needs no new
HTTP endpoint; earlier non-resumable recovery uses the endpoints below.

Protected placement status remains `ready` while replacing and optionally
includes `replacement: { id, status, failureCode }`. `status` is `reserving`
before resource attachment, then the pending asset's technical state. After
failure, the optional replacement disappears and the placement's safe
`failureCode` describes the failure while the old ready video remains intact.
Explicit placement deletion and visibility edits return conflict while a
replacement is reserved or pending; whole-product deletion is still allowed.

### Product non-resumable resource recovery (V3.11, implemented locally)

Use these routes when an existing issued upload cannot resume. Authorization
refresh remains a separate operation and never creates or deletes resources.
Both recovery routes require the existing authenticated Product media-editor
access (super-admin, or admin with `PRODUCTS` control), `Idempotency-Key`
(trimmed 8–128 characters), and exactly one top-level `file` property:

- `POST /api/v1/products/:productId/videos/:videoId/upload-recovery`
- `POST /api/v1/products/:productId/videos/:videoId/replacements/:replacementId/upload-recovery`

```json
{
  "file": {
    "clientId": "<original file selection ID>",
    "filename": "original.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 12345678
  }
}
```

The descriptor uses the existing MP4/MOV validation and 250 MiB declared-size
limit. `clientId` and filename must match the original placement or pending
replacement. Do not send `showInReelsFeed`, provider identifiers, credentials or
a TUS URL. The original visibility is preserved. Use a new key for this recovery
attempt and retain that key and descriptor for all retries.

The backend checks the exact current asset and original 24-hour deadline.
Matching management status 0 plus a fresh-signed trusted TUS HEAD 404, or actual
management GET 404, permits recovery. Resumable/complete TUS resources,
management statuses 1–6, identity mismatches and malformed observations return
`409 VIDEO_UPLOAD_CONFLICT`; unavailable provider observations return sanitized
`503 VIDEO_PROVIDER_UNAVAILABLE`. An elapsed deadline or legacy resource without
a trusted stored URL also returns conflict. Invalid input returns
`400 VIDEO_INVALID_MEDIA`; existing 401/403 authentication/access behavior applies.

The first accepted request commits the recovery marker and durable old-asset
cleanup, then returns `202`:

```json
{
  "data": {
    "productVideoId": "<unchanged placement ID>",
    "recoveryId": "<recovery attempt ID>",
    "position": 0,
    "status": "recovering"
  }
}
```

Pending replacement responses also include the unchanged `replacementId`.
No upload URL or credentials are returned while waiting. Retry the same route,
key and descriptor after background cleanup progresses. A cleanup operation
must complete trusted TUS termination/absence, management GET 404 and poster
cleanup before the retry can allocate a new resource. Management DELETE
acceptance alone does not unlock allocation. Queue failure leaves committed work
due for the sweeper; repeated requests never bypass cleanup verification.

When cleanup is complete, one retry claims creation and returns `201` with the
same response IDs/position, `status: "awaiting_upload"`, and `upload` using the
existing upload-instruction shape above. Its resource and authorization expiry
are capped by the original deadline and configured six-hour maximum. An issued
same-key replay returns that resource with fresh bounded authorization, without
another allocation. The frontend must resend the file bytes using TUS HEAD/PATCH
to `upload.uploadUrl`. It must not POST to `upload.endpoint`.

Changed actor/file/target for the same key, a different key while recovery is
active, concurrent creation already in progress, failed attempts and stale or
cancelled generations return `409 VIDEO_UPLOAD_CONFLICT`. An issued resource
whose lifetime has elapsed returns `409 VIDEO_UPLOAD_RESOURCE_EXPIRED`; replay
does not extend it. Unknown create outcomes retain their marker and block blind
allocation. Known failed or late resources enter durable cleanup; failure to
persist cleanup returns `500 VIDEO_CLEANUP_PERSISTENCE_FAILED`. Safe provider
setup failures return `503 VIDEO_PROVIDER_UNAVAILABLE`. Retry with the same key
after an uncertain response to discover any committed issued result.

Placement ID, slot, selection position, feed visibility, replacement ID and
original abandonment deadline stay unchanged. Pending recovery preserves and
pins the old active ready asset; cancellation or a changed generation prevents
late adoption. Existing cancellation routes remain available during recovery.
Protected placement status optionally includes
`recovery: { id, status, failureCode }`, with status `waiting_cleanup`, `reserving`
or `failed`; it contains no provider identifiers or upload credentials. The
optional field disappears after issue or marker detachment.

Both recovery responses set `Cache-Control: private, no-store`. Existing-session
recovery remains available when new Product reservation flags are off. This is
local implementation evidence, not rollout authorization. V3.11.A real database,
provider, queue and device acceptance remain open; V3.12.A automatic orphan
wiring remains off. Equivalent Reel non-resumable recovery is documented above;
its real-system acceptance remains open under V5.09.2.A.

### Interrupted upload setup recovery

There is no new public/admin recovery route. The worker recovers a setup
reservation that remains `reserving` for one hour without issuing credentials.
This is separate from the 24-hour window for an already-issued upload.

For initial batches, failed setup placements disappear from protected status
only after known-asset cleanup obligations are committed. For replacements,
the old ready placement remains and reports `VIDEO_UPLOAD_SETUP_EXPIRED`; its
stale `replacement` field disappears. The editor may retry with a new
`Idempotency-Key`. Existing failed batch keys remain conflicts; failed
replacement keys report their terminal status without granting another upload.

A late provider response cannot attach to the recovered reservation or cancel
a newer replacement. Already-issued sessions are excluded from setup recovery.
Finding provider resources whose GUID was never saved still requires separate
orphan discovery; setup recovery must not be presented as complete orphan cleanup.

### Saves and errors

`PUT` and `DELETE /api/v1/videos/saved/:videoId` return `200` with
`{ "data": { "videoId": "...", "isSaved": true|false } }`. Repeated calls
return the same end state. A Product Video ID or unavailable editorial Video
is not accepted for a new save.

Videos operational failures retain PetYard's error envelope, for example:

```json
{
  "status": "fail",
  "error": [{ "code": "PRODUCT_VIDEO_LIMIT_REACHED" }],
  "message": "The product already has three video slots in use."
}
```

The stable code, not the wording of `message`, is the client contract.
Initial proposed codes include `VIDEO_NOT_AVAILABLE`,
`VIDEO_NOT_SAVEABLE`, `VIDEO_UPLOAD_DISABLED`,
`PRODUCT_VIDEO_LIMIT_REACHED`, `VIDEO_UPLOAD_CONFLICT`,
`VIDEO_UPLOAD_RESOURCE_EXPIRED`,
`VIDEO_ASSET_NOT_READY`, `VIDEO_INVALID_MEDIA`,
`VIDEO_PROVIDER_UNAVAILABLE`, and `VIDEO_DELETE_UNCONFIRMED`.

### YouTube player-error reporting (V6.07, implemented locally)

`POST /api/v1/videos/:id/player-errors` uses `protectUserOrGuest`: send a valid
Bearer token or the existing `x-guest-id`. An invalid supplied Bearer token
cannot fall back to a guest identity. Normal account/phone-verification rules
remain in effect. The endpoint is disabled when `VIDEOS_PUBLIC_ENABLED=false`.

Request body:

```json
{ "youtubeId": "dQw4w9WgXcQ", "reason": "unavailable" }
```

Only `youtubeId` and `reason` are accepted. `youtubeId` is the exact ID from the
public Video currently being played, not a URL. `reason` is `unavailable` or
`embedding_disabled`. The server requires a currently published YouTube Video
with the matching ID; stale screens after a YouTube-link change cannot report
against the replacement content. Reels and Product Video IDs are not accepted.
Do not send raw error text, player payloads, URLs, reporter IDs or device data.

The verified [YouTube IFrame API error reference](https://developers.google.com/youtube/iframe_api_reference#onError)
maps code `100` to unavailable/removed/private content and `101`/`150` to an
owner's embedding restriction. Flutter maps those codes to the two reasons
above. Codes `2`, `5`, `153`, buffering, autoplay blocking and ordinary network
timeouts are not evidence that the content became private/non-embeddable;
show a safe local player error without sending this content-unavailability
report. In particular, `153` concerns missing client identification/referrer.
The actual Flutter bridge remains a device-acceptance gate.

Success and duplicate reports return `202` with
`{ "data": { "reported": true } }` and `Cache-Control: private, no-store`.
This acknowledges persistence/processing of an untrusted report, not confirmed
YouTube unavailability or completed push delivery. The response does not expose
recipient counts, alert IDs or whether there are currently eligible recipients.
Flutter must show the safe playback error independently of reporting success;
reporting must not block navigation or create an automatic retry loop.

The route allows 10 attempts per client IP per 15 minutes per API process,
including rejected attempts, using the installed project rate limiter.
Rotating `x-guest-id` does not evade this IP limit. It returns safe
`429 VIDEO_REPORT_RATE_LIMITED` and standard rate-limit headers. This is not a
distributed request-limit guarantee; a shared limiter store is needed before
claiming a cross-instance limit.

Other failures retain the existing error envelope: `422 VIDEO_INVALID_PLAYER_ERROR`
for invalid fields/IDs/reasons; `404 VIDEO_NOT_AVAILABLE` for disabled, missing,
unpublished, wrong-type or stale-link targets; and `503 VIDEO_REPORT_UNAVAILABLE`
when durable alert persistence cannot commit. Middleware uses its existing
`401`/`403` authentication/account errors.

Alerts go to active, non-deleted, non-banned super admins and admins with
`VIDEOS` permission, selected when the report transaction runs. Reuse the
existing notification outbox and worker for retryable in-app/push delivery.
Deduplicate per Video/current YouTube ID/recipient/UTC calendar day, regardless
of reporter or reason. The day changes at 00:00 UTC, not 24 hours after the
first report; a changed YouTube ID has a separate alert identity.

The report transaction writes the existing private owner association fence,
checks publication/link identity and records all recipient obligations together.
It does not change editorial revision, publication status or pending proposals.
The outbox stores fixed safe display text and
`source: { domain: "videos", event: "youtube_player_error", referenceId: <Video ID> }`,
without reporter identity or raw payload. The reported reason appears only as
an allowlisted value. Staff must verify before a super admin uses the existing
Unpublish action; reports never cause automatic unpublication or Data API calls.

Local tests use real services/repositories/routes/auth and fake external
database adapters. Mongo transaction retries/unique indexes, notification
worker restart/delivery, multiple API instances and Flutter callbacks still
need explicitly approved real-system/device acceptance. No new queue, schema,
dependency, secret or runtime switch was added.

### Playback sessions and analytics

#### V8.04 daily totals and report rules — accepted 2026-10-02

The user approved these four rules and reuse of the existing analytics
service/HTTP test boundaries with fake external database adapters:

1. Update daily totals in the same Mongo transaction as each newly committed
   raw event. Exact retries and semantic no-op events do not increment totals.
   Use `Africa/Cairo`, including DST, and split watch milliseconds at local
   midnight. No new queue, worker or dependency is required.
2. Retain totals for twelve calendar months, using explicit expiry checks and
   Mongo TTL cleanup. Keep historical totals after content deletion.
3. Protect reports with the existing `protect`, admin/super-admin role checks
   and `ANALYTICS` control. Guests, customers and moderators cannot read reports.
4. Start with one daily-report endpoint, filtered by content kind, optional
   content ID and inclusive Cairo calendar-date range. Default to the last
   thirty days; bound each request to 366 days and reuse Videos pagination.
   Unavailable YouTube playback metrics remain unavailable, not zero.

Implementation and real Mongo acceptance remain separate. This approval does
not authorize live writes, flag enablement, deployment or changing existing
playback/session/save requests.

#### V8.04 daily report implementation — local, 2026-10-02

`GET /api/v1/videos/analytics/reports/daily` is a staff-only route. It uses
`protect`, admin/super-admin roles and the existing `ANALYTICS` control; an
admin with only Videos control cannot read analytics. The service repeats the
same role/control rule. Existing guest/account ingestion and save routes stay
unchanged. Turning off public video flags does not hide historical staff totals.

Allowlisted query fields:

- `kind`: `all` (default), `youtube`, `reel`, or `product`.
- `contentId`: optional stable editorial or Product Video ObjectId, not product
  ID, provider GUID, playback-session ID or asset ID.
- `from`, `to`: both present or both omitted. Strict `YYYY-MM-DD` Cairo calendar
  dates, inclusive, ordered, with at most 366 dates. Timestamps, impossible
  dates and structured/repeated query values are rejected. When omitted, use
  today and the preceding 29 Cairo dates, not a rolling 720-hour interval.
- `page`, `limit`: existing Videos pagination; defaults 1/20, maximum limit 100.

Success is the existing pagination envelope, not a new raw-event response:
`{ totalResults, totalPages, page, results, data }`. Each data row is
`{ day, kind, contentId, metrics }`; `day` is a calendar date, not a timestamp
subject to the Egypt response replacer. Sort by day descending, then kind and
content ID ascending. Rows exist only for recorded daily activity; do not infer
missing telemetry from absent rows. Concurrent writes can change pagination
between requests; this is not a frozen report export.

`metrics` contains only `impressions`, `playStarts`, `qualifiedViews`,
`progress25`, `progress50`, `progress75`, `completions`, `watchTimeMs`, `replays`,
`shares`, `saveAdditions`, `saveRemovals`, `playbackErrors`, `rebuffers` and
`rebufferTimeMs`. Supported metrics without a recorded increment are zero.
For YouTube, only impressions, shares, save additions/removals and bounded
playback errors are available; all other metric fields are `null` until the
separately required Flutter bridge/duration proof and backend capability change.
Product Video save additions/removals are `null` because that content is not
saveable. Rebuffer duration is assigned to the episode-end date; only watch
milliseconds are split at midnight. No percentage, unique-viewer count or
unrequested derived performance score is invented.

Responses are private/no-store. Invalid filters return `422` with
`VIDEO_INVALID_ANALYTICS_REPORT` (existing pagination errors retain their own
code). Database failure returns safe `503 VIDEO_ANALYTICS_UNAVAILABLE`; no raw
database details, viewer identity, session ID, provider descriptor, URL or
expiry field is exposed. Authentication/authorization use existing 401/403.

Every new counted raw event and actual save transition updates its daily row
in the same transaction as the source mutation. Exact retries and uncounted
semantic duplicates do not increment totals. Watch intervals are half-open:
milliseconds before midnight belong to the previous day, while the derived
qualified-view marker belongs to the crossing chunk's event-end date. A chunk
ending exactly at midnight puts no watch milliseconds in the following day.
History remains readable after content removal without joining the deleted
owner, and automatic save cleanup does not increment customer-removal totals.

Expiry is twelve calendar months after the bucket's next Cairo start-of-day,
normalized to local start-of-day; calendar month-end clamping applies. Incrementing
an existing row never extends expiry. A unique kind/content/day index and an
absolute TTL index are declared; reports explicitly filter `expiresAt > now`
instead of waiting for Mongo TTL deletion. No viewer, location or playback
session dimension is stored in daily totals.

Nineteen new service/HTTP tests pass under Cairo and UTC process timezones;
full Videos suite 617/617. Real Mongoose update casting uses a fake collection,
and independent read-only review found no confirmed blocker. Real Mongo
collection/index creation, contention/retries and TTL execution remain V8.04.A.
This is prospective aggregation: existing raw records are not automatically
backfilled, and duplicate submission is not a backfill mechanism. No new queue,
worker, dependency, environment variable, live call or rollout was introduced.

#### V8.01 session contract — accepted 2026-10-02, not implemented

The user approved all six choices and the test seams below. This contract
replaces the earlier session-issuance draft below. It
does not change the accepted metrics, 30-day raw-event retention, 12-month
aggregate retention, or absence of public counts and viewer/location reports.

1. Use one `POST /api/v1/videos/analytics/playback-sessions` endpoint for
   `{ kind: "youtube" | "reel" | "product", contentId }`. Protect issuance and
   the existing proposed event-ingestion endpoint with `protectUserOrGuest`.
   The response is `{ data: { playbackSessionId, expiresAt } }`, private and
   no-store. Keep the existing GET HLS grants and their responses unchanged;
   YouTube needs no HLS grant. Flutter creates the analytics session before
   playback and obtains the HLS grant separately for uploaded media. Anonymous
   playback stays available; reporting needs an account or guest identity.
2. Issue an opaque server-generated session valid for 30 minutes, bound to
   the same user or guest identity. Check expiry explicitly even if Mongo TTL
   deletion has not run. Do not extend it on event submission; longer viewing
   obtains a new session. Expired submissions are rejected, not backfilled.
   This lifetime does not extend the independent maximum 15-minute HLS token.
3. Reuse current public eligibility rules and feature switches. Internally
   capture the active asset ID for uploaded media or current YouTube ID.
   Recheck visibility and exact media at ingestion. After removal, unpublish,
   deactivation, replacement or disabled public access, reject events from
   the old session; committed historical events remain. Pending Product Video
   deletion follows its existing provider-acceptance rule, not queue acceptance.
   A media change between session issuance and an HLS grant can invalidate
   that session; Flutter then starts a new one rather than attributing new
   media to the old session. Admin previews do not create public analytics.
4. Resolve content identity and media generation from the session, never from
   client provider identifiers. Deduplicate event IDs within each session.
   Session ownership is private transient data; do not retain it in raw event
   documents or daily aggregates, expose it in reports, or store raw IP/location.
   The existing proposed bounded event envelope below remains the starting
   point; batch sizes, skew limits and metric calculations need the next review.
5. Enforce expiry and retention using absolute instants. Require explicit
   offsets on client event timestamps, not bare Egypt-local timestamps. Accepted
   daily reporting buckets use `Africa/Cairo`, including daylight-saving changes,
   rather than a fixed UTC+3 shift. The current JSON timezone replacer is a
   presentation helper, not authority for expiry or aggregation. Session expiry
   must remain unambiguous on the wire. YouTube playback metrics remain
   unavailable until the Flutter bridge is verified; a screen open is not a view.
6. Accepted TDD seams are the Videos analytics service and its HTTP routes,
   exercising real internal modules with fake external database/provider adapters
   and a controlled clock. No real Bunny, Mongo, Redis or notification calls.

Approval does not enable public flags or authorize live provider/database
tests. No backend implementation or new environment variable exists yet.
Staff report permissions and exact metric/batch rules remain subsequent
contract decisions.

#### V8.01 event ingestion limits — accepted 2026-10-02, not implemented

The user approved all five ingestion choices below. The session contract above
also remains accepted; metric semantics still need the separate V8.03 approval.

1. Keep `POST /api/v1/videos/analytics/events` with an `events` array of 1–50
   items. Each item carries `eventId` (frontend UUID), `playbackSessionId`,
   `type` and `occurredAt` (ISO timestamp with explicit offset), plus only
   allowlisted fields for its type. A batch can contain different sessions
   owned by the same caller. Bound the logical UTF-8 JSON body to 64 KiB;
   reject unknown fields/types and non-finite numbers. This bound is additional
   to the current global 5 MiB parser; it does not claim that the global parser
   already has a 64 KiB transport limit.
2. Accept client event types `impression`, `play_start`, `progress_25`,
   `progress_50`, `progress_75`, `complete`, `watch_time`, `replay`, `share`,
   `playback_error` and `rebuffer`. Derive the two-second qualified view from
   admitted watch time rather than accepting a client `qualified_view` count.
   Saves/removals come only from committed save endpoint mutations. Do not
   accept free-text errors, provider URLs, viewer IDs, locations or arbitrary
   metadata. Exact per-type fields and counting rules are the V8.03 review;
   no raw client watch values become billing or security authority.
3. Accept events no more than five minutes old or 30 seconds ahead of server
   time, and no earlier than session issuance minus that same 30-second clock
   tolerance. Sessions must still be valid when received. Timestamp offsets
   are normalized to absolute instants; explicit +03:00 is not a three-hour
   clock error. Reject delayed offline batches outside these limits, without
   extending the session or inventing missing watch time.
4. Validate and persist each batch atomically. An invalid event/session means
   no new event in that batch is committed; Flutter removes the invalid items
   before retrying the remainder. Exact retries return success without counting
   events twice. Reusing the same session/event ID with different normalized
   content returns a conflict instead of silently overwriting history. Return
   safe aggregate acknowledgement counts only, not session owner details.
   Limit each session to 500 distinct committed events; exact duplicates do
   not consume that allowance.
5. Reuse installed `express-rate-limit`: accepted ceilings are 120 session
   requests per minute per IP and 60 ingestion requests per minute per IP,
   including rejected attempts. Guest-ID rotation does not reset IP limits.
   These are per API process, like the existing Videos limiter, not a claim of
   distributed rate limiting; existing global API limits also apply. No new
   Redis limiter framework, queue, package or configuration variable is proposed.

The V8.03 watch/progress/replay/error semantics below are accepted. Basic-event
and uploaded playback ingestion plus committed-save recording are local.
Reporting permissions and aggregate
processing remain V8.04. The already approved service/HTTP test seams cover
validation, identity isolation, replay, transaction rollback, time bounds and
rate limits with controlled external adapters.

#### V8.03 metric rules — accepted 2026-10-02, playback/save processing implemented locally

The user approved all seven per-type behavior choices below. All values
remain approximate client telemetry, never proof of
human attention, unique viewers, unique footage coverage or provider billing.

1. One analytics session represents one playback attempt, lasting at most
   the accepted 30 minutes. Pause/resume, seeking and HLS renewal keep that
   session. Returning after leaving the item, an actual automatic loop or an
   explicit restart from the beginning creates a new session. For a loop or
   explicit restart, Flutter sends `replay` in the new session when playback
   actually starts, not when a button is merely tapped. Count it once in that
   session, alongside its ordinary start/view/progress metrics. Do not require
   a viewer-linked session history or a separate playback-cycle identifier.
   A still-valid HLS URL can be reused if the media has not changed; the new
   analytics session does not require a new URL on every loop. Issuance or
   reporting failure must not prevent playback; it leaves missing analytics,
   not invented events. The accepted IP/session ceilings still apply.
2. Count `impression` once per session when at least half the video surface
   is visible for one continuous second while the app is in the foreground.
   A cover in a list or a prefetched off-screen player is not an impression.
   Count `play_start` once when the player actually begins playback, not when
   the screen opens, a session is issued or an HLS request succeeds. Impression,
   start, qualified-view, each progress milestone, completion and replay are
   semantic once-per-session metrics: different event IDs cannot multiply
   them. A new session is not a new unique person; do not report unique viewers.
3. `watch_time` supplies integer `durationMs` from 1 through 10,000, with
   `occurredAt` representing the end of that continuous watched interval.
   Flutter emits a chunk every five seconds and a final shorter chunk when
   pausing, buffering, leaving, backgrounding or finishing. Count only real
   elapsed time while playing in the foreground and at least half visible.
   Paused/background/off-screen/buffering time and seeking jumps do not count;
   faster playback does not multiply elapsed watch time. Reject overlapping
   intervals and totals exceeding elapsed server time since session issuance.
   Require new events to be submitted in chronological order for each session;
   previously committed exact duplicates remain harmless even on later retries.
   Derive one qualified view after at least 2,000 admitted milliseconds in that
   playback attempt. Shorter videos can complete without a qualified view.
4. For uploaded media, use the session's server-verified asset duration.
   `progress_25`, `progress_50`, `progress_75` and `complete` require a finite
   `positionSeconds` between zero and that duration. A progress event counts
   once only after both that position and admitted watch time reach its
   fraction of the duration. A seek alone does not earn progress. Completion
   requires an actual end callback, position within the last one second, and
   admitted watch time of at least 95% of duration. An event failing these
   conditions is invalid for atomic batch acceptance; Flutter flushes watch
   chunks before milestone/completion events. Do not automatically invent
   intermediate milestones from a later event. These measures still do not
   prove which unique portions of footage were watched.
5. Each distinct `share` means the user invoked the system share action,
   not confirmed delivery to another person. Count distinct actions, but not
   retries. `playback_error` requires only a bounded `reason` from `network`,
   `decode`, `unavailable`, `embedding_disabled`, or `unknown`, plus the common
   event fields; do not accept messages or URLs. Each actual error occurrence
   counts once by event ID. `rebuffer` means a buffering episode after playback
   started, excluding initial loading; its integer `durationMs` is 1–300,000
   and it is sent once at the end of the episode. Its duration must fit elapsed
   session time. Repeated callback notifications are not new episodes. Errors
   and rebuffering do not grant views or watch time. YouTube content-failure
   staff alerts remain the separate V6.07 endpoint, not an ingestion side effect.
6. Do not accept granular YouTube start/watch/progress/completion/replay/
   rebuffer events until a verified Flutter bridge supplies reliable callbacks.
   Initially only impression, share and bounded playback-error telemetry is
   available for YouTube; unavailable playback metrics must be represented as
   unavailable, not zero. The repository currently stores canonical YouTube
   identity but no verified YouTube duration. Before admitting percentage or
   completion metrics, separately verify duration as well as bridge callbacks.
   Do not silently trust a client duration or add per-event YouTube API calls.
   The release/device proof remains a gate, not something fake adapters establish.
7. Save metrics come from successful committed state transitions: creating
   a save counts one addition, removing an existing save counts one removal.
   Idempotent retries/no-op save requests and automatic cleanup after editorial
   deletion do not count as customer save/removal actions. Product Videos
   remain unsaveable. Retain the existing user/guest separation and public
   `canSave` behavior; no client save analytics type is added.

Only the common fields and the per-type fields named above are allowed. A
stored event's normalized payload remains immutable, including when its
semantic once-per-session metric was already counted. New IDs are distinct
raw events within the accepted ceiling; raw event counts are not automatically
the derived view/start/milestone totals. Daily metrics use event instants in
`Africa/Cairo`; the qualified-view increment belongs to the watch chunk that
crosses its threshold, and watch milliseconds are split at Cairo midnight.
Aggregate processing, report access and retention execution remain V8.04.

#### Session issuance — V8.02.1 implemented locally, 2026-10-02

`POST /api/v1/videos/analytics/playback-sessions` uses the real
`protectUserOrGuest` middleware and accepts only:

```json
{ "kind": "youtube", "contentId": "507f1f77bcf86cd799439011" }
```

`kind` is `youtube`, `reel` or `product`; `contentId` is the editorial Video
ID or Product Video placement ID, not a product or provider ID. Guest headers
must be nonempty and at most 256 characters; user identity comes from verified
authentication. Identity types remain separate even for equal ID strings.
Success is HTTP 201, private/no-store:

```json
{
  "data": {
    "playbackSessionId": "<opaque server UUID v4>",
    "expiresAt": "2026-10-02T20:30:00.000+00:00"
  }
}
```

The explicit offset is deliberate: it avoids the global JSON presentation
helper turning a Z timestamp into a timezone-less local string. Stored dates
and expiry comparisons remain absolute. The response contains no viewer ID,
provider GUID, asset ID, signed URL, key or analytics count. Existing HLS GET
grants remain unchanged and anonymous playback remains available as before.

Issuance reuses existing public editorial/Product Video eligibility queries
and the shared verified Reel-asset policy. Product gallery sessions do not
require `showInReelsFeed`; pending individual Product Video deletion remains
eligible until provider acceptance/confirmed absence, exactly as public media.
Independent public flags still govern the respective content kinds.

The private `VideoPlaybackSession` collection stores its identity binding,
captured YouTube ID or uploaded asset/upload generation, verified uploaded
duration, issuance time and fixed 30-minute expiry. Identity fields are not
selected by default. A TTL index requests expiry cleanup; service resolution
rejects expired or malformed stored timestamps regardless of TTL timing.
Internal `resolveSession` is the future ingestion seam, not a public GET. It
rechecks caller ownership, expiry, flags and exact current media, returning no
stored viewer identity. Title edits alone do not change media generation.

The post-persistence eligibility check compensates by deleting a newly created
session if it cannot safely be returned. This eager cleanup of an unsuccessful
issuance is separate from routine TTL expiry; no contract requires retaining
such an unused session. A failed/uncertain database acknowledgement or cleanup
can leave an unreturned row for TTL cleanup, without granting playback or event
authority. Issuance is not an atomic lock on future publication changes; future
event writes must recheck eligibility at their persistence boundary.

Errors use safe existing envelopes: 422 `VIDEO_INVALID_PLAYBACK_SESSION` for
invalid request data; 404 `VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE` for missing,
hidden, wrong-type or disabled content; 503 `VIDEO_ANALYTICS_UNAVAILABLE` for
storage failures. Existing authentication errors remain 401/403. The limiter
counts all 120 attempts/minute/IP, including failed authentication, and returns
429 `VIDEO_ANALYTICS_RATE_LIMITED`; it is per process, not distributed.

Local proof: 14 new service/HTTP tests and the full 542-test Videos suite pass.
Real internal repositories, validators, schema validation and authentication
run against fake external Mongo adapters and a controlled clock. The real Egypt
JSON replacer is included in HTTP checks. No provider, Redis or notification
call is needed. Real Mongo index/TTL execution, deployed routing, database-loss
behavior and publication races remain live acceptance gates. Event ingestion,
watch/progress/replay calculations, saves-to-analytics recording and aggregate
reports were not implemented in the session checkpoint; basic-event ingestion
was added in the checkpoint below. An issued session is not proof of collected
analytics or Flutter integration readiness.

#### Basic-event ingestion — V8.02.2a implemented locally, 2026-10-02

`POST /api/v1/videos/analytics/events` uses real `protectUserOrGuest`, the same
typed identity as issuance and an independent 60-attempt/minute/IP/process
limiter. It currently accepts only `impression`, `share` and `playback_error`
for eligible YouTube/Reel/Product Video sessions:

```json
{
  "events": [
    {
      "eventId": "a9c3903f-83f1-4c60-8d58-f23288693a94",
      "playbackSessionId": "<opaque server UUID v4>",
      "type": "impression",
      "occurredAt": "2026-10-02T23:00:01+03:00"
    }
  ]
}
```

Each item requires a frontend-generated UUID event ID, server-issued session
UUID v4, supported type and explicit-offset ISO timestamp with seconds and
optional 1–3 fractional digits. UUID casing and equivalent offsets normalize
before comparison. All items must belong to the authenticated user or current
guest. Guest and user identities are not interchangeable. `playback_error`
additionally requires `reason`: `network`, `decode`, `unavailable`,
`embedding_disabled` or `unknown`. Other fields are rejected. This endpoint
does not replace the existing YouTube player-error/staff-alert endpoint.

The logical UTF-8 JSON body is limited to 64 KiB and 1–50 events; the global
parser remains separately bounded. The batch commits atomically across session
groups. Success is HTTP 200 with `Cache-Control: private, no-store`:

```json
{ "data": { "accepted": 1, "duplicates": 0 } }
```

`accepted` counts newly stored event IDs, not semantic views. A second
impression with a distinct event ID is stored with internal `counted:false`,
while an exact ID/payload retry is a duplicate. Shares and errors may repeat
with distinct IDs. No viewer, provider, URL, raw stored event or aggregate
report data is returned. No public counts were added.

New events must be no more than five minutes old, 30 seconds ahead of server
time, or earlier than issuance minus 30 seconds. Boundaries are inclusive.
New events for each session must be in nondecreasing chronological order,
including across batches. Exact normalized retries bypass these new-event
time/chronology checks, but never bypass ownership, fixed 30-minute session
expiry, public flags or current media eligibility. Reusing a committed or
same-batch session/event ID with a changed normalized payload is a conflict.
The ceiling is 500 distinct events per session; exact duplicates do not consume
it. A batch failing any check commits no new event or session-state change.

The server requires at least one second elapsed since issuance for an
impression; FE must still implement the accepted continuous foreground/half-
visible rule. This telemetry is not independent proof of human attention.
Transactionally fenced current eligibility includes exact YouTube link or
uploaded generation, editorial publication, Product Video placement/active
parent, verified asset and issued Reel upload ownership. Product gallery-only
media does not require feed opt-in. Pending Product Video deletion remains
eligible until provider acceptance/confirmed absence. Runtime public flags and
expiry are rechecked before completing the transaction callback; runtime flags
are not Mongo-backed locks.

The private raw-event schema requests a unique `{playbackSessionId,eventId}`
index and TTL removal 30 days after server receipt. It stores no viewer ID,
IP, location, provider URL or credential. Identity binding remains only in the
short-lived private session collection. TTL execution and deployed unique
indexes are not proven by local schema/fake-adapter tests.

Safe errors use the existing envelope:

- 422 `VIDEO_INVALID_ANALYTICS_EVENTS`: malformed/unknown fields or types,
  invalid timestamps, chronology/time bounds or too-early impression.
- 413 `VIDEO_ANALYTICS_PAYLOAD_TOO_LARGE`: logical JSON exceeds 64 KiB.
- 404 `VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE`: malformed/missing/expired,
  wrong-owner or no-longer-eligible session/media.
- 409 `VIDEO_ANALYTICS_EVENT_CONFLICT`: changed normalized payload for the same
  session/event ID.
- 409 `VIDEO_ANALYTICS_SESSION_LIMIT`: more than 500 distinct committed events.
- 422 `VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE`: known native metric types whose
  processing is not implemented yet. This currently includes `play_start`,
  `watch_time`, all progress milestones, `complete`, `replay` and `rebuffer`
  for every content kind. Unavailable is not a measured zero.
- 503 `VIDEO_ANALYTICS_UNAVAILABLE`: safe storage failure without DB details.
- 429 `VIDEO_ANALYTICS_RATE_LIMITED`: the ingestion attempt ceiling, including
  failed authentication/validation. Existing 401/403 authentication errors apply.

Local proof: twenty-one additional ingestion service/HTTP tests; full Videos
suite 563/563. Actual repositories, validators, schema validation and auth run
against fake external Mongo adapters and a controlled clock. Atomic fake
rollback/concurrency is not real Mongo MVCC/transaction retry proof. Real
indexes/TTL, concurrent publication/replacement/removal, database failure and
deployed route acceptance remain V8.02.2.A. Native playback metric processing,
save transition hooks, daily aggregates and report permissions remain pending.
No live writes, flag changes or full frontend handoff occurred.

#### Uploaded playback events — V8.02.2b / V8.03.1 implemented locally, 2026-10-02

This extends the same protected `POST /api/v1/videos/analytics/events` route,
atomic batch, limits and `{data:{accepted,duplicates}}` acknowledgement. It
supersedes V8.02.2a's temporary unavailable gate for uploaded Reels and Product
Videos. The earlier unavailable behavior still applies to granular YouTube
metrics because no verified bridge/duration capability was added.

All events require the same event/session UUIDs, type and explicit-offset
`occurredAt`. Only these additional fields are accepted:

| Event type | Additional fields |
| --- | --- |
| `impression`, `play_start`, `replay`, `share` | None |
| `playback_error` | Bounded `reason`, unchanged |
| `watch_time` | Integer `durationMs`, 1–10,000 |
| `rebuffer` | Integer `durationMs`, 1–300,000 |
| `progress_25`, `progress_50`, `progress_75`, `complete` | Finite `positionSeconds`, 0 through server-verified duration |

Do not send a client duration, qualification flag, visibility flag, end flag,
episode ID, location, free-text error or other metadata. FE sends `complete`
only from the actual end callback and `replay` in a fresh playback session when
a loop/restart actually begins. Those claims remain client telemetry, not
independent proof. A missing start event does not itself discard otherwise valid
watch chunks; `rebuffer` does require an admitted actual start. Once a start is
reported, neither watched nor buffering intervals may start before it.

`occurredAt` is the interval end for watch/buffer events. The interval start is
the end minus `durationMs`. New intervals may touch, but must not overlap prior
watched or buffering intervals, including across batches. Watch intervals must
not extend before issuance minus the accepted 30-second clock tolerance;
total admitted watch must not exceed elapsed server time since issuance.
Buffering episodes must fit elapsed session time and begin after the reported
start; initial loading is not rebuffering. A repeated interval with a new event
ID is invalid, not another view/watch/buffering episode. Exact normalized retries
remain duplicates before these new-event checks, while session/media ownership,
expiry and availability remain mandatory.

The first watch chunk reaching 2,000 admitted milliseconds receives the internal
immutable `qualifiedViewCounted:true`; later watch chunks receive false. Only
the crossing chunk will contribute the future daily qualified-view increment.
Raw watch events contain admitted duration, not a client `qualified_view`
counter. The private session stores admitted watch total, first reported start,
last watch/buffer interval end and once-per-session semantic state. No viewer ID
is added to raw events and none of this state is returned in the HTTP response.

Milestones require both callback position and admitted watch at 25/50/75% of
server duration. Completion requires position in the final second and at least
95% admitted watch. FE flushes watched chunks before callbacks, in chronological
order; an invalid callback rolls back the entire batch, including its preceding
watch chunks. A later milestone/completion does not generate earlier milestones.
Starts, replay, impressions, milestones, completion and qualified view cannot
be multiplied by different event IDs in one session. Short videos may complete
without reaching two seconds or qualifying a view.

The existing safe error codes continue. Unsupported granular YouTube metrics
return 422 `VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE` for well-formed payloads;
malformed per-type fields still return `VIDEO_INVALID_ANALYTICS_EVENTS` before
capability checks. Native interval/milestone conditions use that invalid-event
code. Changed normalized payloads remain conflicts. Saves are not client event
types, and staff alerts remain separate from analytics ingestion.

Local proof: twenty-one additional playback service/HTTP tests; full Videos
suite 584/584. No public or admin report counts were added. Real Mongo retry/
index/TTL proof, FE callback accuracy and device acceptance remain unverified.
Committed customer save additions/removals, Cairo-day splitting/aggregates,
aggregate retention and admin report permissions are still pending. No live
calls, rollout flags, packages or environment values changed.

#### Server save transitions — V8.03.2 implemented locally, 2026-10-02

FE keeps using the existing protected `PUT` and
`DELETE /api/v1/videos/saved/:videoId` routes with bearer or `x-guest-id`.
Successful HTTP 200 responses remain:

```json
{ "data": { "videoId": "507f1f77bcf86cd799439011", "isSaved": true } }
```

DELETE returns the same fields with `isSaved:false`. Both responses now
explicitly set `Cache-Control: private, no-store`. No playback session,
analytics body, client event ID or additional FE call is needed for saving.

The backend creates one private `save_added` raw event for an actual insertion
and one `save_removed` for an actual customer removal. Repeated PUT on an
existing save or DELETE on an absent save creates no event; removing and then
re-saving creates a new addition. Typed user/guest saves remain independent,
including when their ID strings match. Product Video saves remain unavailable.
Hidden editorial saves can still be removed; new hidden-content saves stay 404.

Save-state mutation and analytics insertion share the same Mongo transaction
and editorial owner write fence. The existing duplicate-key recovery on
addition remains. Removal fences the owner without requiring public status,
then records only a nonzero actual deletion. Permanent editorial deletion
continues its separate direct save cleanup and produces no customer removal
event. Database/event failure aborts both changes and returns safe
503 `VIDEO_SAVE_UNAVAILABLE` without private database details. If the database
acknowledgement is uncertain, the client may retry the desired saved state;
an already committed state is a no-op, not another analytics transition.

Server events reuse the private raw collection with immutable server UUID,
editorial kind/content ID, type, counted marker, server-observation/receipt
timestamps and expiry thirty days after receipt. They have no viewer identity,
IP, location, provider URL, playback session or client payload hash. The shared
unique session/event index still distinguishes server events by their UUIDs;
its existence/execution remains a real Mongo acceptance check. Client playback
events still require their session binding/hash and the client ingestion
allowlist still rejects `save`, `save_added` and `save_removed`.

Local proof: fourteen additional service/HTTP tests and full Videos suite
598/598; actual public/editorial services, repositories, schemas and auth use
fake external database adapters and controlled time. Fake concurrency and
rollback are not real Mongo MVCC/index/transaction proof. No public or admin
aggregate reports, new configuration/dependency/queue, live calls, rollout or
frontend field changes were added. V8.04 aggregate/report work and real Mongo
save/removal/deletion acceptance remain pending.

#### Earlier session-issuance draft — superseded, not implemented

The accepted Reel/Product Video playback-grant routes return at least
`{ "url": "...", "expiresAt": "..." }`. Add a server-issued
`playbackSessionId` to the grant response for analytics deduplication. Because
YouTube has no HLS grant, propose
`POST /api/v1/videos/:id/playback-session` for a visible YouTube Video,
returning `{ playbackSessionId, expiresAt }` before the WebView starts. This
extra endpoint is an engineering interface choice to satisfy Q139 and needs
final contract review.

Proposed analytics request to `POST /api/v1/videos/analytics/events`:

```json
{
  "events": [
    {
      "eventId": "<frontend UUID>",
      "playbackSessionId": "<server-issued ID>",
      "type": "play_start",
      "occurredAt": "<ISO timestamp>",
      "positionSeconds": 0
    }
  ]
}
```

The server resolves content identity from the playback session rather than
trusting a client-supplied provider ID. The validator bounds batch length,
timestamp skew, position/watch-time values, and event type; deduplication is
by event ID within the session. Save/removal actions are counted from the
save endpoint, not duplicated from client analytics. YouTube progress/watch
events are admitted only when the mobile WebView bridge is verified.

### Explicit Product Video deletion

The protected `DELETE /api/v1/products/:productId/videos/:videoId` records a
durable intent and returns a pending/deleting status while Bunny acceptance
is unresolved. The admin status read reports provider acceptance, safe
rejection, or retry state. Public media remains until Bunny accepts deletion
or a GET confirms absence. This avoids pretending that queue acceptance or an
HTTP request timeout means the provider video was deleted.
