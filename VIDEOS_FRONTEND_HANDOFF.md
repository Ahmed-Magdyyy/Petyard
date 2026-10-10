# Petyard Videos — complete frontend integration handoff

Contract snapshot: **2026-10-10 (Africa/Cairo)**. Audience: customer/mobile/Flutter developers, admin frontend developers, and client QA. Scope: all **53 frontend-facing Videos routes**, plus the existing Product gallery and notification touchpoints used by these flows.

This is the implementation contract for the current local backend. It explains request and response fields, identity, retained client state, customer and staff workflows, generation changes, retries, concurrency, error handling, and acceptance cases. It does not claim that a frontend implementation or deployment has passed acceptance. Older contract plans contain historical proposals; use this document and current source when they differ.

## Contents

- [Delivery state and integration boundaries](#delivery-state-and-integration-boundaries)
  - [Workflow map: use the right content family](#workflow-map-use-the-right-content-family)
  - [Editorial and upload state are independent](#editorial-and-upload-state-are-independent)
- [Full frontend route index](#full-frontend-route-index)
- [Shared client integration](#shared-client-integration)
  - [Shared transport, identifiers, and retained state](#shared-transport-identifiers-and-retained-state)
- [Customer and mobile contract: public Videos, Product gallery, and playback analytics](#customer-and-mobile-contract-public-videos-product-gallery-and-playback-analytics)
  - [1. Scope and route map](#1-scope-and-route-map)
  - [2. Identity and headers](#2-identity-and-headers)
  - [3. Error envelope and shared constraints](#3-error-envelope-and-shared-constraints)
  - [4. Public listing, detail, and feed](#4-public-listing-detail-and-feed)
  - [5. Playback grant, expiry, and player lifecycle](#5-playback-grant-expiry-and-player-lifecycle)
  - [6. Save and unsave](#6-save-and-unsave)
  - [7. YouTube player error reporting](#7-youtube-player-error-reporting)
  - [8. Analytics issuance and client retention](#8-analytics-issuance-and-client-retention)
  - [9. Analytics event submission](#9-analytics-event-submission)
  - [10. Staff daily analytics report contract](#10-staff-daily-analytics-report-contract)
  - [11. Endpoint status and error-code index](#11-endpoint-status-and-error-code-index)
  - [12. Mobile integration acceptance matrix](#12-mobile-integration-acceptance-matrix)
  - [13. Evidence and remaining uncertainty](#13-evidence-and-remaining-uncertainty)
- [Admin Editorial Videos and Reels](#admin-editorial-videos-and-reels)
  - [Base paths, authorization, and response conventions](#base-paths-authorization-and-response-conventions)
  - [Creating YouTube videos and Reel drafts](#creating-youtube-videos-and-reel-drafts)
  - [Reel upload sessions](#reel-upload-sessions)
  - [Replacement media and published-media preservation](#replacement-media-and-published-media-preservation)
  - [Submission, review, publication, and retries](#submission-review-publication-and-retries)
  - [Cover images](#cover-images)
  - [Permanent deletion](#permanent-deletion)
  - [Ordering and list behavior](#ordering-and-list-behavior)
  - [Provider-operation monitoring](#provider-operation-monitoring)
  - [Error handling by endpoint family](#error-handling-by-endpoint-family)
  - [Client state and idempotency checklist](#client-state-and-idempotency-checklist)
  - [Protected Reel preview](#protected-reel-preview)
  - [Source evidence and limits](#source-evidence-and-limits)
- [Product Video administration](#product-video-administration)
  - [Product Video endpoint inventory](#product-video-endpoint-inventory)
  - [Product file request dictionary](#product-file-request-dictionary)
  - [Product creation response and TUS grant dictionary](#product-creation-response-and-tus-grant-dictionary)
  - [Product initial-upload flow](#product-initial-upload-flow)
  - [Product admin status response dictionary and interpretation](#product-admin-status-response-dictionary-and-interpretation)
  - [Product replacement flow](#product-replacement-flow)
  - [Product nonresumable upload recovery](#product-nonresumable-upload-recovery)
  - [Product private preview, visibility, cancellation, and deletion](#product-private-preview-visibility-cancellation-and-deletion)
  - [Product endpoint error/action matrix](#product-endpoint-erroraction-matrix)
  - [Product administration acceptance checklist](#product-administration-acceptance-checklist)
- [Notification reception and operator follow-up](#notification-reception-and-operator-follow-up)
  - [Incoming Videos notification fields](#incoming-videos-notification-fields)
- [Final frontend acceptance and release checklist](#final-frontend-acceptance-and-release-checklist)
  - [Evidence already available](#evidence-already-available)
  - [Work after this handoff](#work-after-this-handoff)
- [Documentation authority and maintenance](#documentation-authority-and-maintenance)

## Delivery state and integration boundaries

The selected local backend implementation and acceptance checkpoint is complete. No known unfinished local implementation remains in that accepted scope. On 2026-10-10 the user authorized the combined Videos/Prime GitHub release and chose to pull it on the VPS personally. The encrypted release environment enables public Videos, Product Videos, uploads, Reel/cover pipeline readiness and bounded orphan recovery. **A GitHub push does not deploy or activate the VPS.** See [VIDEOS_GITHUB_RELEASE.md](VIDEOS_GITHUB_RELEASE.md) for the server steps and release verification. An HTTP 404/503 from an old VPS build or closed feature is not evidence that the newly implemented route is broken.

| Gate | Meaning for frontend integration |
|---|---|
| `VIDEOS_PUBLIC_ENABLED` | Public editorial YouTube/Reel surfaces and associated eligibility. Disabled lists are empty; unavailable detail/grants fail closed. |
| `PRODUCT_VIDEOS_PUBLIC_ENABLED` | Product Video public feed, gallery projection, playback, and analytics eligibility. Independent of editorial public switch. |
| `PRODUCT_VIDEO_UPLOADS_ENABLED` | New Product initial/replacement allocation. Existing status/refresh/recovery/cancellation are separate. |
| `REEL_UPLOADS_ENABLED` plus `REEL_UPLOAD_PIPELINE_READY` | New initial/replacement Reel allocation requires both switches. Readiness defaults to false when absent and is an operator release switch, not a live worker-health signal. |
| `VIDEO_COVER_PIPELINE_READY` | New editorial multipart cover upload requires explicit pipeline activation. Defaults to false; removal/status are separate. |
| `VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED` | Worker recovery of allocations with uncertain create responses. Exact owner/generation checks constrain adoption and cleanup; this does not permit bulk deletion of unrelated Bunny media. |
| Automatic orphan recovery enablement | Backend operations only; default off. Frontend cannot trigger a provider scan or allocate directly to work around an uncertain creation. |
| Deployed API, worker, database/indexes, Redis, provider configuration | Release prerequisites. A working API process without its worker cannot guarantee processing/cleanup progresses. |

No API endpoint exposes feature configuration as a frontend capability registry. Use agreed release configuration and documented availability responses. Do not implement credential settings in the frontend. Stream management/read-only/token credentials, storage/CDN credentials, YouTube verification key, and webhook authentication belong to backend deployment.

The provider webhook is **POST `/api/v1/integrations/bunny-stream/webhook`** (backend integration, excluded from the 53 client routes). The frontend never submits provider status hints, signatures, Ready events, or verification results. Status is established by backend reconciliation and provider reads. Missed webhooks do not authorize the client to mark media ready; poll the appropriate application status route.

### Workflow map: use the right content family

| Content family | Creation/admin home | Customer discovery and playback | Publication/review | Save |
|---|---|---|---|---|
| Editorial YouTube | Videos admin, `kind:youtube` | YouTube list/detail, YouTube embed | Admin review plus separate Publish; superAdmin creation starts published after verification | Yes, editorial Video ID |
| Editorial Reel | Videos admin, `kind:reel` | Reel feed/detail, signed HLS | Admin review plus separate Publish; superAdmin initial policy can auto-publish after verified readiness/HLS | Yes, editorial Video ID |
| Product Video | Nested Product Videos administration | Existing Product `media` gallery, optional feed, signed HLS | Worker readiness makes media eligible; no editorial review/publish action | No |

Do not send Product Videos to editorial review routes, use a parent Product ID as playback content ID, or put YouTube embed URLs into the HLS player.

### Editorial and upload state are independent

`status:draft/in_review/approved/published/unpublished` belongs to editorial visibility/review. `awaiting_upload/processing/ready/failed/deleting/deleted` belongs to media state. A Reel can be editorial Draft with Ready media; an Approved Reel still needs explicit Publish. A Published Reel can have a separate pending replacement that is not public. A Product placement can be Ready while a pending replacement is Awaiting upload.

`202` means accepted/pending asynchronous work. `201` means a created/issued API resource, not completed bytes or publication. TUS 100% means transferred bytes, not ready media. Provider deletion accepted, verified management absence, origin object absence, and CDN cache eviction are different facts. Never collapse them into one frontend boolean.

## Full frontend route index

The following inventory is generated from the six current mounted frontend routers. Parameter names reflect source. In nested Product routes `:id` means Product ID; in public Product playback it means placement ID; in editorial/public Video routes it means editorial Video ID. Provider `:operationId` is an operation ID. Trailing root slash is optional under normal Express routing.

| Area | Method | Full API path |
|---|---|---|
| Public editorial/customer | GET | `/api/v1/videos/youtube` |
| Public editorial/customer | GET | `/api/v1/videos/feed` |
| Public editorial/customer | GET | `/api/v1/videos/saved` |
| Public editorial/customer | PUT | `/api/v1/videos/saved/:videoId` |
| Public editorial/customer | DELETE | `/api/v1/videos/saved/:videoId` |
| Public editorial/customer | POST | `/api/v1/videos/:id/player-errors` |
| Public editorial/customer | GET | `/api/v1/videos/:id/playback` |
| Public editorial/customer | GET | `/api/v1/videos/:id` |
| Public Product playback | GET | `/api/v1/product-videos/:id/playback` |
| Analytics/customer and staff | GET | `/api/v1/videos/analytics/reports/daily` |
| Analytics/customer and staff | POST | `/api/v1/videos/analytics/events` |
| Analytics/customer and staff | POST | `/api/v1/videos/analytics/playback-sessions` |
| Editorial administration | GET | `/api/v1/videos/admin` |
| Editorial administration | PATCH | `/api/v1/videos/admin/positions` |
| Editorial administration | GET | `/api/v1/videos/admin/:id` |
| Editorial administration | GET | `/api/v1/videos/admin/:id/preview` |
| Editorial administration | POST | `/api/v1/videos/admin` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/upload-session` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/replacement-upload-session` |
| Editorial administration | GET | `/api/v1/videos/admin/:id/replacement-upload-session` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId/authorization` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId/recovery` |
| Editorial administration | DELETE | `/api/v1/videos/admin/:id/replacement-upload-sessions/:sessionId` |
| Editorial administration | GET | `/api/v1/videos/admin/:id/upload-session` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/upload-sessions/:sessionId/authorization` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/upload-sessions/:sessionId/recovery` |
| Editorial administration | DELETE | `/api/v1/videos/admin/:id/upload-sessions/:sessionId` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/submit` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/approve` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/reject` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/publish` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/unpublish` |
| Editorial administration | PATCH | `/api/v1/videos/admin/:id/position` |
| Editorial administration | PATCH | `/api/v1/videos/admin/:id/draft-position` |
| Editorial administration | POST | `/api/v1/videos/admin/:id/cover` |
| Editorial administration | DELETE | `/api/v1/videos/admin/:id/cover` |
| Editorial administration | DELETE | `/api/v1/videos/admin/:id/pending-change` |
| Editorial administration | DELETE | `/api/v1/videos/admin/:id` |
| Editorial administration | PATCH | `/api/v1/videos/admin/:id` |
| Provider operations/superAdmin | GET | `/api/v1/videos/admin/provider-operations` |
| Provider operations/superAdmin | POST | `/api/v1/videos/admin/provider-operations/:operationId/retry` |
| Product administration | GET | `/api/v1/products/:id/videos/:videoId/preview` |
| Product administration | GET | `/api/v1/products/:id/videos` |
| Product administration | POST | `/api/v1/products/:id/videos/upload-sessions` |
| Product administration | POST | `/api/v1/products/:id/videos/:videoId/upload-authorization` |
| Product administration | POST | `/api/v1/products/:id/videos/:videoId/upload-recovery` |
| Product administration | POST | `/api/v1/products/:id/videos/:videoId/replacement-upload-session` |
| Product administration | POST | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-authorization` |
| Product administration | POST | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-recovery` |
| Product administration | DELETE | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-session` |
| Product administration | DELETE | `/api/v1/products/:id/videos/:videoId/upload-session` |
| Product administration | PATCH | `/api/v1/products/:id/videos/:videoId` |
| Product administration | DELETE | `/api/v1/products/:id/videos/:videoId` |

Existing `GET /api/v1/products/:id` provides the Product gallery `media` union. It is an existing Product route, not a 54th Videos route. Existing notification inbox/read routes are described in the notification integration chapter. No generic Video progress PATCH, frontend Ready-confirmation, resource-create, recovery-by-ID GET, or Product Video save route is implemented.

## Shared client integration

### Shared transport, identifiers, and retained state

All application paths below are relative to the deployed API origin. Keep the origin in environment configuration. A response path such as `playbackHref` is an API request path; it is not a URL that a video player can load directly. Use the normal application HTTP client for API calls and the separate TUS/media client for provider bytes. Never forward the application bearer token to Bunny or to a signed CDN URL. Send only the provider upload headers returned by the backend to its returned upload resource.

IDs are strings. Editorial `Video.id`, catalog `Product.id`, Product Video placement `productVideoId`, internal `assetId`, Reel `sessionId`, Product `replacementId`, and `recoveryId` are different identifiers. Even when two are Mongo ObjectIds, they cannot be substituted. Do not derive a business ID from a provider `VideoId`, a URL, a filename, an array index, or a thumbnail. Backend revision numbers are concurrency tokens, not timestamps or IDs.

Successful responses are endpoint-specific. Most Videos controllers return `{data: ...}`; do not apply a second generic success wrapper. Pagination itself contains another `data` array. The daily analytics report is an exception: its pagination object is returned directly. Error responses use `{status, error, message}`. `status` is `fail` for 4xx and `error` for 5xx. `error` is an array whose entries can carry a domain `code`; authentication, upload parsing, and generic failures can have an empty array. Check HTTP status first, then recognized codes, then show a safe message. Development-only `stack` is not a client contract. Never parse English message text as the primary API discriminator.

Treat missing, `null`, empty arrays, and `false` distinctly. Public and admin DTOs differ. Fields that are absent on one union member do not become valid request fields. Preserve `false` visibility and numeric position `0`; avoid truthiness defaults. Ignore unknown response fields for forward compatibility, but send only documented request keys because many validators reject extras. Interpret dates using the actual wire serialization rule immediately below; most current response dates do not include a timezone marker. Upload `expiresAt` and `resourceExpiresAt` are Unix seconds; HLS preview/playback expiry and analytics expiry are date strings. Do not compare seconds directly with JavaScript `Date.now()` milliseconds.


#### Wire timestamps: Cairo local strings versus absolute expiry

The full application installs **egyptTimezoneReplacer** in [server.js](D:/Projects/GitHub/petyard/src/app/server.js). This matters beyond the service/controller DTOs. Any response string exactly matching **YYYY-MM-DDTHH:mm:ss.SSSZ** is shifted to **Africa/Cairo** and then emitted **without Z or an offset**. Date objects serialized by Express undergo the same transformation. Example service value **2026-10-10T12:00:00.000Z** becomes wire value **2026-10-10T15:00:00.000** under Cairo's offset for that date. Do not assume the offset is always three hours: the utility uses the Cairo timezone and its date-specific offset.

This affects editorial/public publication and review timestamps, admin creation/update fields, proposal dates, abandonAt, provider-operation dates, notification createdAt, and current public/private HLS **expiresAt**. The field tables call these ISO/date-time timestamps, but the **current full-server wire value is a Cairo local timestamp without timezone**, not a portable UTC instant. An isolated controller/service test without the full server replacer may show Z instead. Examples below showing such Z values describe service DTO values; apply this wire rule when decoding actual full-server responses.

| Timestamp category | Actual handling |
|---|---|
| Date objects or exact millisecond UTC Z strings in JSON responses | Current full server converts to Cairo local string without an offset. Parse explicitly in Africa/Cairo, not the device's timezone. |
| Analytics session expiresAt | Service intentionally returns **+00:00** rather than Z; the replacer leaves it unchanged. Parse as an absolute instant. |
| Upload expiresAt/resourceExpiresAt integers, AuthorizationExpire string | Unix seconds. No timezone conversion; multiply seconds by 1000 only when a millisecond API needs it. |
| Daily report day/from/to | Calendar-date strings for Africa/Cairo report buckets; do not convert them as UTC timestamps. |
| Client analytics occurredAt request | Must include explicit Z or numeric offset. The response replacer does not license sending offsetless request events. |

Mandatory client adaptation: use the frontend's timezone-aware date facility to interpret offsetless response timestamps in Africa/Cairo and convert to an instant before expiry comparisons. Do not append Z to the bare value, subtract a fixed two/three hours, or let a device in another country parse it as its own local time. If the existing client cannot resolve Cairo local timestamps, refresh a grant immediately before use and handle provider expiry failure safely while the wire-time compatibility decision is resolved; do not promise precise expiry scheduling from a misparsed value. Around ambiguous daylight-saving transition times, a bare local value cannot always identify one unique instant; avoid relying on it alone for an exact boundary. This is a current shared-wire compatibility limitation, not a new field or an agreed API change.

Use the standard HTTP **Date** header, when available, to estimate server/client clock skew for frontend diagnostics; it is not a backend session or authorization override. Do not fabricate analytics event times to get around clock-window rejection. Display dates in the user's intended timezone only after correct Cairo/offset parsing. The document preserves the existing shared serializer; changing global date compatibility is outside this handoff and requires a separate scoped decision.

Source: [egyptTimezone.js](D:/Projects/GitHub/petyard/src/shared/utils/egyptTimezone.js), [server.js](D:/Projects/GitHub/petyard/src/app/server.js), and [videoAnalytics.service.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.service.js).

#### Data retention map

| Client state | Retain for | Retention and cautions |
|---|---|---|
| Stable guest ID | Guest saves, analytics ownership, YouTube reports | Existing guest identity storage; do not rotate per API call. Guest/user namespaces are separate and do not merge on login. |
| Editorial Video ID and `kind` | Detail, save, playback, admin editing, analytics | Stable application identity. A YouTube ID or provider GUID is not a replacement. |
| Product ID and Product Video placement ID | Gallery playback and nested Product administration | Retain both: playback uses placement ID, nested administration also needs Product ID. |
| Original selected file and normalized request manifest | Upload/resume/recovery | Retain access to the exact original bytes until terminal completion/cancellation. A path may become inaccessible after restart; obtain platform permission/access again. Do not assume metadata alone can reconstruct bytes. |
| `clientId` | Match batch results to selected files | Client-generated per selected file, stable across retries. Match by `clientId`, not response order. |
| `Idempotency-Key` and exact request JSON | Safe retry after lost response | Persist before the first POST. Retain until the operation is reconciled. Use a new key only for a genuinely new operation after checking previous state. |
| Reel `sessionId` / Product `replacementId` | Authorization refresh, cancellation, recovery | Keep the identifier belonging to the intended media generation. A stale generation must not overwrite a newer generation in the UI. |
| `recoveryId` | Correlate a recovery already requested | Diagnostic/client tracking; no generic GET-recovery route exists. Retry the original recovery endpoint with the same key and file. |
| `upload.uploadUrl` and upload expiry | TUS HEAD/PATCH resume | Temporary operation state; replace after successful nonresumable recovery. Do not store in public content models, analytics, logs, or share payloads. |
| `upload.headers` | Authorized TUS requests | Sensitive short-lived signatures. Store only in protected transient upload state if restart persistence is necessary; refresh when required. Never embed server provider keys. |
| `revision` and pending revision | Conditional editorial actions | Refetch and retain the latest backend values. After conflict, refresh before constructing another mutation. |
| Public `playbackHref` | Fresh playback grants | Stable API path while the business entity exists. |
| Signed HLS `url` | Current player instance | Memory only; replace on expiry. Not a durable media identifier or a share URL. |
| Analytics session, event IDs, exact event payload | Bounded event retry | Keep only while same identity/current media/session remains valid; never move stale events into a new session. |
| Page/filter/language/identity | Paged lists | Cache keys must include all relevant inputs. Refresh after identity/language/content changes. |

Do not put provider credentials, signed upload authorization, signed HLS URLs, device tokens, or `.env` values into the frontend bundle, local debug logs, crash payloads, analytics, source control, or this handoff. The client receives bounded upload signatures, not the Stream API key. YouTube server verification credentials are also backend configuration; public `youtubeId` and `embedUrl` are sufficient for the player.

#### Retry ownership and race handling

Cancel a client request on navigation if desired, but cancellation of HTTP does not undo a committed backend operation. Disable duplicate UI submissions while one logical action is pending. Network timeout means outcome unknown. For idempotent writes, retry the same logical request/key; for editorial revision actions and non-idempotent mutations, refetch state before retrying. Keep last server state and a separate local pending indicator; do not promote an optimistic result to authoritative publication/readiness.

Recommended retry policy is bounded exponential backoff with jitter for transport failures, 429, and safe 5xx retries. Respect `Retry-After` if present, but do not assume every route sends it. This policy is frontend guidance; the backend specifies no universal retry interval or polling duration. Never automatically retry 400/422 invalid payloads unchanged forever. On 401, follow normal access-token renewal/login; retries must retain the original operation identity and must not silently change the actor. On 403, show access unavailable and stop. On 404/409, reconcile the current business state before deciding the next action. A late response belonging to an old item, filter, account, asset, upload, or revision must not replace newer state.

No WebSocket/SSE upload-status subscription or generic operation cancellation route is implemented. Poll existing status/detail routes with bounded backoff while the relevant screen is active; pause polling on background or lost connectivity and refresh on return. Polling delay and UI timeout are client choices, not new business expiry rules. A client timeout does not authorize another provider allocation.

#### Browser transport, response headers, and account changes

Browser integration must satisfy the deployed application's CORS policy. Current source allows **https://petyard.netlify.app** and, only in development mode, **http://localhost:3002** and **http://localhost:3001**. A different frontend origin needs an explicit deployment configuration change; the client cannot fix a blocked preflight by adding an application header. Current API methods include GET, POST, PUT, PATCH, and DELETE. Authorization, Content-Type, Accept-Language, x-guest-id, and Idempotency-Key are in the allowed request-header list. The API's CORS policy does not configure Bunny's separate TUS/CDN origins. Validate provider HEAD/PATCH CORS and readable **Upload-Offset**/**Upload-Length** headers in the actual admin browser. Native mobile HTTP requests are not subject to browser CORS.

The full application normally generates **X-Request-Id** for diagnostics and exposes that header, along with **ETag**, through API CORS. A request ID identifies one HTTP attempt; it is not a Video/session ID, revision, idempotency key, or token. Do not send it instead of any business identifier. ETag exposure does not mean Videos endpoints implement conditional mutations with If-Match; use the documented revision bodies. Parser errors can occur before request-ID middleware, so do not require X-Request-Id on every failure. The ordinary HTTP Date header can assist clock-skew diagnostics, as described above, but is not explicitly exposed by the current CORS configuration. Browser code may therefore be unable to read it, Retry-After, or rate-limit headers even if they are present on the network response. Keep a safe bounded backoff fallback; exposing those headers is a separate server configuration decision.

Application JSON responses use application/json; TUS responses are provider protocol responses and may have no JSON body. Public Videos, playback, analytics, and many admin operations set **Cache-Control: private, no-store**. Authentication/role/rate-limit failures and some parsers can occur before the controller sets it; other controllers set it only after a successful service call. An early error can omit the cache header. Absence does not make private admin/session data safe for shared caching. No universal custom success/error header or backend Retry-After value is guaranteed. Do not interpret a CORS/network failure as a received HTTP 404 or a confirmed failed write.

The permanent editorial DELETE uniquely requires a JSON **revision** body. Ensure the chosen HTTP client sends bodies on DELETE; do not rely on a helper that discards them. Cover/replacement/upload cancellation and other DELETE routes use their documented no-body forms. Let the HTTP client generate multipart boundaries for cover uploads. Use a separate provider client for TUS/media so shared API interceptors do not forward the application bearer token, cookies, or application-only headers to Bunny.

On logout, login, account switch, or permission change, invalidate identity-scoped query caches, stop old polling/upload/player tasks, detach callbacks, and discard old analytics sessions/queues. Preserve unresolved upload metadata only in a protected store keyed to its original actor and target; do not replay it as another actor. A local logout does not cancel a backend upload or undo a committed mutation. The original authorized actor must reconcile it through the documented routes after reauthentication, or use an expressly authorized staff action where the server permits it. Never silently replay an old idempotency key with a new account. Guest and user save/analytics namespaces stay separate.

Source: [server.js](D:/Projects/GitHub/petyard/src/app/server.js), [publicVideo.limiters.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.limiters.js), [videoAnalytics.limiters.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.limiters.js), and the endpoint controllers cited in each chapter. This section records source behavior; it does not assert that a deployed origin, browser preflight, or provider CORS has passed acceptance.

#### Field provenance, request reuse, and storage rules

The detailed endpoint tables define types, required/optional fields, limits, and meaning. This registry adds the field's producer, its next use, and whether it should be saved. A shared name such as **id**, **status**, **position**, or **expiresAt** has different meanings in different objects; use the complete field path and content family. Grouped names in a row share the same provenance and retention rule, but retain each value separately when its endpoint requires it.

Registry navigation: [request inputs and headers](#request-inputs-and-headers); [public content and gallery](#public-content-product-gallery-and-mutation-acknowledgements); [editorial administration](#editorial-administration-and-pending-proposals); [uploads and status](#uploadsessionstatus-objects-and-provider-protocol); [analytics](#analytics-input-acknowledgement-and-daily-report-fields); [provider diagnostics and envelopes](#provider-operation-diagnostics-and-shared-envelopes). The [browser transport section](#browser-transport-response-headers-and-account-changes) explains CORS, readable headers, DELETE bodies, and account changes.

**Storage rules used below:** **screen state** means an in-memory model/query cache scoped to the current account, target, language, and filters; it must be refreshed after mutations or stale-state responses. **operation state** means the exact unresolved request/IDs/actor/file reference and idempotency key, saved before sending when restart recovery is required; use the client's protected storage and remove obsolete values after reconciliation. **secret transient state** means short-lived signatures/resource URLs, held in memory or protected temporary storage only for an active upload. **retry queue** means the exact bounded analytics events for one identity/session, never a permanent user/media identifier. The backend does not require a particular storage database or package. Do not put credentials in ordinary preferences, browser localStorage, public query caches, logs, or crash reports.

##### Request inputs and headers

| Field/header | Comes from | Used next / how to retain |
|---|---|---|
| `Authorization` | Existing application login/token-renewal flow | Application API authentication only. Use the established protected auth store; never a provider request or an event body. |
| `x-guest-id` | Existing stable guest-identity flow | Guest saves, reports, and analytics. Retain through the existing guest store; keep separate from a user ID. |
| `Accept-Language` | Current app language | Public localized responses; include in query-cache keys. Re-request after changing language. |
| `Content-Type` | HTTP body encoder | application/json for JSON, generated multipart/form-data for covers, application/offset+octet-stream for TUS PATCH. No durable retention. |
| `Idempotency-Key` | Client-generated once per logical create/recovery operation | Same original POST on uncertain-result retry. Save with exact body, original actor, target, and file in operation state before sending; never rotate to bypass unresolved work. |
| Path `id` / `videoId` | Current catalog Product or returned editorial/placement ID, according to route | Reuse only in the route family's documented role. Retain target context; never substitute an asset, provider, notification, or array ID. |
| Path `sessionId`, `replacementId`, `operationId` | Matching backend session/replacement/operation response | Exact generation-specific refresh/recovery/cancel or operation retry. Keep with its owner and purpose; remove stale action state after reconciliation. |
| Query `page`, `limit`, `kind`, `status` | User's selected list/report/monitor settings or documented defaults | Same list on paging/refresh; retain as query state. Valid kind/status options are endpoint-specific. |
| Query `asset` | Staff preview selection, active or pending | Preview only. Screen state; never an asset ID and never an upload mutation field. |
| Query `contentId`, `from`, `to` | Staff report filter and selected Cairo calendar dates | Daily-report reads only. Query state; from/to must be supplied together. |
| Query `warehouse` | Existing Products warehouse selection | Existing Product detail/batch reads, not a Videos upload field. Include in Product query-cache keys. |
| Body `ids` | Selected catalog Product IDs | Existing Products batch request. Keep deduplicated request context to reconcile unavailable IDs; no placement/provider IDs. |
| Body `kind` on editorial create | Staff's selected YouTube/Reel creation family | Immutable family on the created record. Keep with returned editorial ID; not editable through metadata PATCH. |
| `title_en`, `title_ar`, `description_en`, `description_ar` | Staff's editor form; use active or own pending content as appropriate | Only documented editorial create/metadata edit bodies. Keep unsent form draft separately from server state. Do not resend the entire response object. |
| `youtubeUrl` | Staff's submitted or reconstructed supported HTTPS YouTube URL | YouTube create/edit input only. The response supplies `youtubeId`, not the original URL. When prefilling an editor from `youtubeId`, use a supported URL such as https://youtu.be/{youtubeId}; submit `youtubeUrl`, not `youtubeId`. |
| `files`, `file` | Selected file manifest(s) | Initial batch versus single replacement/recovery request, as documented. Keep exact manifest and original byte access in operation state. |
| `clientId` | Client-generated stable Product file correlation | Matches initial/replacement results and recovery manifest. Operation state; absent from Reel manifests and Product refresh responses. |
| `filename`, `mimeType`, `sizeBytes` | Selected file's safe name, exact MIME, and actual byte length | Backend metadata validation and exact-file TUS/recovery. Operation state; not a path, estimated duration, or provider ID. |
| `showInReelsFeed` | Explicit Product feed choice, defaulted by backend on initial creation | Initial Product manifest or exact visibility PATCH. Keep server-confirmed value in screen state; omit from replacement/recovery manifests. |
| Multipart `cover` | Staff's selected original image bytes | One cover file upload; no companion JSON metadata. Keep local file/form state only until outcome is reconciled. Backend chooses IDs and storage paths. |
| `revision` | Latest backend Video/ordering response | Only permanent deletion, draft ordering, or each bulk-position item. Refresh before a new conditional action; never metadata PATCH or single public-position PATCH. |
| `position`, `draftPosition`, `items[].position` | Staff's requested ordering value | Dedicated ordering endpoint, with null clearing manual order. Keep form intent separately until server acknowledgement. Product positions are not editable through these APIs. |
| `items[].videoId`, `items[].revision`, body `items` | Current editorial IDs and latest revisions selected for one bulk order | Atomic bulk ordering only. Preserve each ID/revision/position tuple; never use list indices as IDs. |
| Reject body `reason` | SuperAdmin's review explanation | Reject endpoint only. Response uses `reviewReason`; no need to retain the request as a credential or concurrency token. |
| Player-error `youtubeId`, `reason` | Attempted YouTube key and observed supported failure | Report current linked media through the narrow report route. Keep only bounded retry context; no raw diagnostic payload. |
| Analytics `kind`, `contentId`, `events`, and event fields | Current content plus actual observed player actions | Session issuance/event submission only. Full event provenance and retention appear below. |

For metadata PATCH, omitted keys leave their existing values. An explicit empty description string clears that description. Current edit normalization uses null-coalescing for supplied fields, so `null` does not reliably mean clear/reset and can retain the base value; do not use it as an edit command. Create normalizes omitted/null optional descriptions to empty strings, while required create titles must be nonempty strings. Position null has an explicitly different, documented clear-order meaning.

##### Public content, Product gallery, and mutation acknowledgements

| Response field | Comes from | Used next / how to retain |
|---|---|---|
| `id`, `kind` | Backend editorial identity/family, or Product placement with kind product | Detail/playback/save/analytics selection. Screen state with family and owner; stable IDs can be retained for app navigation, subject to refetch/access checks. |
| `title`, `description` | Backend localization of editorial content; Product title from localized Product name and description null | Display only. Cache by language/identity; not bilingual metadata edit inputs. |
| `coverUrl` | Backend resolves editorial cover, provider poster, or YouTube thumbnail fallback | Preview display only. Refetch after changes; never a storage/upload identifier. |
| `youtubeId` | Backend extracts/verifies stored YouTube media key | YouTube player and matching player-error report. Keep with current editorial ID; a relink invalidates old report/session context. |
| `embedUrl` | Backend builds YouTube embed URL from that key | YouTube player only. Screen state; not Bunny HLS, an application API path, or a canonical share link. |
| `canSave` | Backend family capability, true for editorial and false for Product Video | Whether to offer save action. Screen state only; no authority to override rejected mutations. |
| `isSaved` | Backend association for resolved identity; false without a matching association and always false for Product feed entries | Server-confirmed save display. Identity-scoped state; never migrate guest state to user implicitly. Gallery Video items omit this field. |
| `publishedAt` | Editorial publication transition | Display/sort context. Screen state using the shared Cairo wire rule; never send as publication permission. |
| `attachedAt` | Product feed attachment timestamp | Product feed display/order context, not Product creation time or file upload time. Screen state; not sent back. |
| `productId`, `productHref` | Backend placement owner and generated Product API path | Fetch existing Product detail/open agreed Product screen. Keep parent Product ID with placement; API path is not a share URL. |
| `playbackHref` | Backend builds appropriate playback-grant API path | Fresh grant requests. Screen state with correct business identity; do not load directly into a player. |
| `durationSeconds`, `width`, `height` | Backend-verified provider metadata of current native video asset | Player layout, progress measurement, and display. Screen state; not client Ready confirmation or upload manifest fields. |
| `aspectRatio` | Backend divides verified width by height | Layout hint. Screen state; no need to persist independently or send back. |
| Product `images`, `media` | Existing Product images plus backend Video projection | Gallery rendering. Retain as Product screen/query state; keep original images compatibility. |
| `media[].id`, `media[].type` | Backend image prefix/placement ID and image/video discriminator | Select renderer; Video id is playback/analytics placement ID, image id is not. Screen state. |
| `media[].position` | Backend index in the combined gallery | Render this response's order. Recompute from refreshed response; not the Product admin placement position or a reorder token. |
| Image `public_id`, `url`, `isMain` | Existing Product image record | Existing image rendering rules. Screen state; none is a Videos ID/upload target. |
| Video `posterUrl` | Backend copied asset poster or null | Video preview image/fallback. Screen state; not the signed playback URL. |
| Batch `products`, `unavailable_product_ids` | Existing Products batch access/projection result | Match requested Product IDs and render available details; unavailable IDs are not partial Product objects. Query state only. |
| Save result `videoId`, `isSaved` | Backend acknowledged identity-specific save/unsave | Patch matching editorial row/save state. Keep current identity's screen state; discard obsolete optimistic intent. |
| Report result `reported` | Backend accepted staff-alert recording | End that request's pending state; not proof of push delivery, new alert, or unpublication. No durable retention needed. |
| Grant/preview `url`, `expiresAt` | Backend signing adapter plus current eligibility check | Player source and expiry/recovery only. Memory-only credential; the expiry is interpreted with the shared wire-time rule. Public analytics issuance is separate; staff preview emits no customer events. |

##### Editorial administration and pending proposals

| Response field | Comes from | Used next / how to retain |
|---|---|---|
| Admin `id`, `kind` | Backend Video record | Staff path selection and edit-family decoding. Account-scoped screen state; stable navigation identity requires refetch. |
| Admin localized title/description fields | Current stored editorial content | Prefill active editor, or use pending content for the own-proposal editor. Screen/form state; send only allowed content keys. |
| Admin `youtubeId` | Current verified stored link | Display/prefill supported youtubeUrl. Do not submit the response key directly in metadata PATCH. |
| `activeAssetId` | Backend current Reel asset binding | Compare current versus pending generations/diagnostics. Screen state only; no frontend mutation accepts it as a replacement. |
| `activeUploadSessionId` | Backend session bound to current active generation, including applied replacement | Generation context. Screen state; choose management routes by the current purpose/status, not the field name alone. |
| `activeCoverId`, `coverUrl` | Backend cover binding and detail-only URL enrichment | Current cover display. Screen state; cover ID is not a request input, and mutations may require a subsequent detail fetch to obtain the URL. |
| `status` | Backend editorial state machine | Available actions and reconciliation. Screen state; no generic status PATCH. |
| `authorId`, `reviewerId` | Backend authenticated creator/most recent reviewer | Ownership display/action hints; backend remains authoritative. Screen state; do not impersonate them through request bodies. |
| `autoPublishWhenReady` | Backend captures initial Reel creator policy | Explain initial automatic publication. Read-only screen state; never recompute from current user role or submit it. |
| `nextPreviewProbeAt` | Backend deferred verified-HLS probe scheduling | Diagnostic waiting information. Screen state using correct date parsing; not a client command, exact polling instruction, or release proof. |
| `reviewReason`, `reviewedAt` | Backend rejection/review operation | Review UI; reason is returned under reviewReason, not request reason. Screen state. |
| `publishedAt`, `unpublishedAt`, `createdAt`, `updatedAt` | Backend transitions/model timestamps | Display/history context. Screen state; not concurrency tokens or editable fields. |
| `position`, `draftPosition`, `revision` | Backend ordering/current revision | Patch matching record on acknowledgements; send only to relevant conditional/order routes. Keep latest revision; a summary is not a full record replacement. |
| `pendingChange` | Backend one current proposal or null/absence | Separate pending UI from live/current content. Screen state; invalidation/cancellation/application must remove obsolete proposal state. |
| `pendingChange.authorId`, `.status` | Backend proposal actor and review state | Ownership/action hints. Screen state; cannot be set by client metadata bodies. |
| `pendingChange.content.kind`, localized titles/descriptions, `.youtubeId` | Backend complete proposal snapshot after normalized edit | Prefill correct pending editor/review comparison. Send only allowed edit keys; YouTube response key becomes a supported youtubeUrl input. |
| `pendingChange.content.coverId`, `pendingChange.coverUrl` | Backend proposed cover reference/removal and detail enrichment | Pending-cover preview/removal comparison. Screen state; never send coverId or returned URL as upload metadata. |
| `pendingChange.uploadSessionId`, `.assetId` | Backend bound replacement generation | Use exact uploadSessionId in purpose-specific authorized routes; assetId is diagnostic only. Keep with Video and pending purpose in operation/screen state. |
| `pendingChange.autoApplyWhenReady` | Backend role policy captured when replacement started | Explain auto-application versus manual review. Read-only screen state; not inferred from initial policy/current requester role. |
| `pendingChange.reviewReason`, `.createdAt`, `.updatedAt`, `.submittedAt`, `.reviewedAt` | Backend proposal history/review | Show history/state; preserve missing/null semantics. Screen state only. |
| `pendingChange.nextPreviewProbeAt`, `.rejectedAssetExpiresAt` | Backend deferred verification/rejected replacement retention | Diagnostic waiting/grace information. Screen state; neither authorizes extension or direct provider cleanup. |
| Draft-order result `videoId`, `draftPosition`, `revision` | Backend successful conditional draft order | Patch only those fields in matching admin record; retain latest revision for later conditional actions. |
| Bulk-order result `kind`, `items[].videoId`, `.position`, `.revision` | Backend atomic update result | Patch listed records and their revisions; omitted records are not renumbered. Screen state. |
| Editorial delete result `videoId`, `status:removed` | Backend local removal and durable cleanup acceptance | Remove matching editor/list/save state; keep unresolved operator context only as needed. Not proof of external/CDN deletion. |

No frontend request accepts whole pendingChange, author/reviewer IDs, automatic-policy fields, internal asset/cover bindings, or timestamps. In particular, **_id**, **__v**, and **associationRevision** are stripped by the repository and are not stable request fields. Admin responses remain model-backed; new schema fields must be reviewed before they become documented client input.

##### Upload/session/status objects and provider protocol

| Field | Comes from | Used next / how to retain |
|---|---|---|
| Reel `videoId`, `sessionId`; Product `productVideoId`, `replacementId` | Backend reserved/issued owner and generation IDs | Exact initial/replacement refresh/recovery/cancel target. Operation state scoped to original owner, purpose, actor, and key. |
| Creation `clientId` | Backend echoes original Product file correlation | Match original bytes/manifests, not array order. Operation state; refresh responses need not echo it. |
| Product `position` | Backend placement allocator | Display/order context; stays through replacement/recovery. Screen/operation state; not a new allocation request input or mixed-gallery index. |
| Response `status` | Backend route-specific reservation, upload, lifecycle, or recovery mapping | Decide whether a grant exists, bytes may be sent, or reconciliation is needed. Screen/operation state; never generic status PATCH. |
| `upload` | Backend creates/signs a usable existing resource | Replace active transient grant only when present/eligible; do not infer usable bytes from HTTP 201 alone. |
| `upload.endpoint` | Provider signing adapter's TUS collection URL | Protocol information only. No frontend POST allocation and no durable content retention. |
| `upload.uploadUrl` | Backend-bound provider-created TUS resource | Exact HEAD/PATCH target. Secret transient state; replace only on a newly issued recovered resource. |
| `upload.expiresAt`, `.resourceExpiresAt` | Backend signature expiry and stored immutable resource horizon | Determine refresh/resource eligibility together with server state. Secret transient/operation state; integer Unix seconds, not playback date strings. |
| `upload.headers.AuthorizationExpire`, `.AuthorizationSignature`, `.LibraryId`, `.VideoId` | Backend provider authorization adapter | Forward unchanged to matching TUS resource. Secret transient state; replace the complete header set on refresh; none is an application token/business ID. |
| TUS `Tus-Resumable`, `Content-Type` | Client's TUS protocol implementation | HEAD/PATCH protocol headers only; generated per operation, not business state. |
| TUS `Upload-Offset`, `Upload-Length` | Provider HEAD/PATCH response, with next PATCH offset from acknowledged server progress | Resume exact file safely. Keep progress hint in operation state but HEAD is authoritative after uncertainty/restart. Clear old offset on fresh resource recovery. |
| Reel status `videoStatus` | Backend current editorial record | Keep upload/media and editorial review states separate. Screen state; not publication proof from completed bytes. |
| `failureCode` | Backend safe active asset/session, cleanup, or prior replacement failure | Display alongside the actual operation. Screen state; not a credential, retry key, or command. |
| Reel `canRefresh` | Backend computes current generation/resource/deadline eligibility | Offer authorization refresh only when indicated. Refresh status before action; stored true cannot override a later rejection. |
| Reel `abandonAt` | Backend original upload deadline | Waiting/deadline UI using shared Cairo date parsing. Screen/operation context; never editable and not reset by recovery. Product status omits it. |
| `recoveryId`, nested `recovery.id` | Backend durable recovery record | Correlation only. Operation state; retry original recovery POST, not a nonexistent GET/POST recovery-ID route. |
| Nested `recovery.status`, `.failureCode` | Backend durable recovery state | Cleanup/reservation/issuance/failure UI. Screen state; no grant returned by status GET. |
| Product nested `replacement.id`, `.status`, `.failureCode` | Backend current pending replacement and pending asset projection | Replacement-specific management and distinct pending progress/error. Screen/operation state; preserve current ready media. |
| Product `showInReelsFeed` | Backend placement visibility flag | Feed toggle once permitted; retain server-confirmed value in screen state, independent of gallery/direct playback. |
| Cancel/delete result IDs and `status` | Backend detach/deletion workflow acceptance | Reconcile appropriate target and retire obsolete upload state. Preserve current media for replacement cancellation; 202 does not prove provider absence. |

##### Analytics input, acknowledgement, and daily-report fields

| Field | Comes from | Used next / how to retain |
|---|---|---|
| Session request `kind`, `contentId` | Current public content family and editorial/placement ID | Session issuance only. Keep correct family/ID with playback; do not use Product catalog ID or provider GUID. |
| Session result `playbackSessionId`, `expiresAt` | Backend UUID v4 and 30-minute absolute expiry | Each event's session binding. Active playback/retry queue only; expiry has explicit +00:00 and is distinct from the HLS grant. |
| Event `eventId` | Client creates UUID once for observed action | Idempotent retry of that event. Retry queue with exact payload; never new ID to manufacture counts. |
| Event `playbackSessionId` | Corresponding backend session result | Owner/current-media checks at ingestion. Retry queue; do not transfer to another identity/item/new session. |
| Event `type`, `occurredAt` | Client classifies actual observation and captures actual timestamp with explicit offset | Validation, chronology, dedupe, and report contribution. Preserve exact logical values in retry queue; not screen-open wall-clock estimates. |
| Event `positionSeconds` | Actual player seek/play position at a milestone | Only native progress/completion types. Retry queue; do not substitute watched duration or invent from a seek. |
| Event `durationMs` | Measured actual advancing-play or stall interval | Only watch_time/rebuffer. Retry queue; distinguish units from durationSeconds and stop intervals on teardown/pause/background. |
| Event `reason` | Observed coarse playback failure | Only playback_error with supported enum. Retry queue; no raw URLs, stacks, or provider secrets. |
| Ingestion `accepted`, `duplicates` | Backend transaction acknowledgement counts | Reconcile the exact submitted events. Numbers, not event-ID arrays or per-event counted flags. All acknowledged submitted events can leave queue; admitted duplicate events must not be counted again by client. |
| Daily `day`, `kind`, `contentId` | Backend Cairo daily aggregate key | Report row/group/filter identity. Report query cache only; historical content can be deleted and no current detail is guaranteed. |
| Daily `metrics` | Backend accepted-event/save-transition aggregation | Display read-only report. Cache with filters; never submit counters to analytics or use as server Ready/visibility state. |
| `impressions`, `playStarts`, `progress25`, `progress50`, `progress75`, `completions`, `replays`, `shares`, `playbackErrors`, `rebuffers`, `qualifiedViews` | Backend counted-event/session rules | Display applicable integer counts or unavailable null, as defined in metric dictionary. Report cache only; do not infer unreported milestones or replace null with measured zero. |
| `saveAdditions`, `saveRemovals` | Backend actual save-state transitions | Report cache only. Never client event types; unavailable for Product Video. |
| `watchTimeMs`, `rebufferTimeMs` | Backend admitted intervals/daily contribution rules | Report durations in milliseconds. Read-only report cache; not request budgets and no API-defined ratio. |

##### Provider-operation diagnostics and shared envelopes

| Field | Comes from | Used next / how to retain |
|---|---|---|
| Operation `id` | Backend durable operation identity | Only superAdmin retry path. Staff monitor state; keep separate from Video/session/recovery IDs. |
| Operation `type`, `status` | Backend worker work category/state | Monitor filters/action hints. Refetch before retry; client cannot edit them or trigger direct provider actions. |
| Operation `failedAttempts` | Backend recorded execution failures | Operator diagnostic count. Screen state; retry does not reset it and it is not a limit supplied by client. |
| Operation `createdAt`, `updatedAt` | Backend operation record timestamps | Operator history. Screen state with shared date parsing. |
| Operation `nextAttemptAt`, `leaseExpiresAt` | Backend schedule/worker lease | Waiting/running diagnostics. Screen state; not a frontend cancel/lease token or permission to run duplicate work. |
| Operation `completedAt`, `lastErrorAt`, `lastEnqueueErrorAt` | Backend completion/provider/queue outcomes | Operator history. Screen state; omission/null is meaningful. |
| Operation `lastErrorCode`, `lastEnqueueErrorCode` | Backend sanitized diagnostics | Safe operator display. Screen state; no raw provider payload or credentials. |
| Retry result `operation`, `queued` | Backend durable pending reset and enqueue attempt | Replace monitor summary; queued false still has durable pending work. Screen state; not provider execution completion. |
| Wrapper `data` | Endpoint controller | Decode object, array, or pagination according to endpoint. Not a universal durable field; daily report and notification list envelopes differ. |
| Paging `totalResults`, `totalPages`, `page`, `results`, nested `data` | Backend query count, page math, and current result projection | Paging/query state. Counts are numbers, rows are array; retain with same filters/language/identity. |
| Error `status`, `error`, `error[].code`, `message` | Shared middleware or endpoint limiter | HTTP status plus recognized stable code for behavior; safe fallback message for display. Bounded sanitized diagnostic state only; error array may be empty. Never parse message text for a business ID. |
| `X-Request-Id`, HTTP `Date`, `Cache-Control`, optional retry/rate-limit headers | API/platform middleware | Diagnostics, private-cache policy, and safe retry timing when readable. None is a request idempotency/session/revision field. |

Notification-specific fields and their producers are detailed in **Notification reception and operator follow-up**. FCM referenceId comes from the alert's editorial Video reference; inbox id comes from the notification record and is reused only for read/delete routes. Localized text, source/action data, read state, and counts are account-scoped inbox screen state. Device token comes from the platform messaging SDK and is retained/registered through the existing protected notification flow; it is never a Video identifier or an analytics field. Do not use a historical notification to restore permission or resurrect deleted content.



## Customer and mobile contract: public Videos, Product gallery, and playback analytics

Source-grounded contract, 2026-10-10. This chapter describes the current local backend implementation and its tests. The public flags are off in the current environment, and this code has not been deployed to the VPS. It does not claim that a mobile client, browser player, or physical device has implemented or accepted the flows.

The older [Videos contract plan](D:/Projects/GitHub/petyard/VIDEOS_API_CONTRACT_PLAN.md) and [Product Media contract plan](D:/Projects/GitHub/petyard/PRODUCT_MEDIA_CONTRACT_PLAN.md) are background only. Where their proposed response examples differ from the implementation, current source and tests below take precedence.

### 1. Scope and route map

The routes are mounted in [src/app/routes.js](D:/Projects/GitHub/petyard/src/app/routes.js):

| Method | Path | Purpose | Access |
|---|---|---|---|
| `GET` | `/api/v1/videos/youtube` | Paged published YouTube editorial videos | Anonymous or authenticated; optional auth is validated when supplied |
| `GET` | `/api/v1/videos/feed` | Paged Reel/Product Video feed | Anonymous or authenticated; optional auth is validated when supplied |
| `GET` | `/api/v1/videos/saved` | Current identity’s saved YouTube videos and Reels | Required user bearer token or `x-guest-id` |
| `PUT` | `/api/v1/videos/saved/:videoId` | Save an eligible YouTube video or Reel | Required user bearer token or `x-guest-id` |
| `DELETE` | `/api/v1/videos/saved/:videoId` | Remove a save | Required user bearer token or `x-guest-id` |
| `POST` | `/api/v1/videos/:id/player-errors` | Report a YouTube embed error for staff review | Required user bearer token or `x-guest-id` |
| `GET` | `/api/v1/videos/:id/playback` | Short-lived signed HLS grant for a Reel | Anonymous or authenticated; optional auth is validated when supplied |
| `GET` | `/api/v1/videos/:id` | Public published editorial video detail (YouTube or Reel) | Anonymous or authenticated; optional auth is validated when supplied |
| `GET` | `/api/v1/product-videos/:id/playback` | Short-lived signed HLS grant for a Product Video | Anonymous or authenticated; optional auth is validated when supplied |
| `POST` | `/api/v1/videos/analytics/playback-sessions` | Issue an opaque analytics session for current media | Required user bearer token or `x-guest-id` |
| `POST` | `/api/v1/videos/analytics/events` | Submit validated client playback events | Required user bearer token or `x-guest-id` |
| `GET` | `/api/v1/videos/analytics/reports/daily` | Staff daily aggregate report | Authenticated admin/super-admin; Admin also needs `ANALYTICS` control |
| `GET` | `/api/v1/products/:id` | Parent product detail that carries the gallery `media` union | Anonymous or authenticated; optional auth is validated when supplied |

The first 12 entries are Videos, playback, saves, and analytics endpoints. The final product-detail route is an existing integration dependency that returns the gallery projection; it is included here because mobile gallery use reaches that endpoint.

Each public response sets `Cache-Control: private, no-store`. The daily report does too. Send `Accept-Language` when a localized title/description is needed; the current middleware selects ar when the header begins with ar (case-insensitive), otherwise en, with no query-language override; the server language middleware sets `req.lang`, which public video projections use. Most successful route responses use `{ "data": ... }`; the report directly returns its pagination object, without an outer `data` key. Errors follow the shared error shape described in §3.

Route/controller sources: [publicVideo.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.routes.js), [publicProductPlayback.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicProductPlayback.routes.js), [videoAnalytics.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.routes.js), and [routes.js](D:/Projects/GitHub/petyard/src/app/routes.js).

### 2. Identity and headers

#### Optional authentication

For public listing, detail, and playback grant routes, no `Authorization` header allows anonymous access. When `x-guest-id` is also absent, there is no saved-state identity; when a valid non-empty guest header is present, public Video projections use that guest for `isSaved`. If a bearer token is supplied, `optionalProtect` validates it. An invalid, expired, deleted-user, or password-invalidated token is rejected with `401`; it does not silently fall back to guest/anonymous access. Sending both a bad bearer token and a valid guest ID still fails because the bearer is attempted first. A valid authenticated user is used as the identity for `isSaved` projections.

#### Required user-or-guest identity

Saves, YouTube error reporting, analytics session issuance, and analytics event ingestion use `protectUserOrGuest`:

* Authenticated request: `Authorization: Bearer <access-token>`. The backend resolves the user and requires the existing verified-phone condition. If this bearer is present but invalid, the request is rejected; `x-guest-id` cannot rescue it.
* Guest request to a protected user-or-guest route: `x-guest-id: <stable opaque client-generated guest identifier>`. Use the same value for all guest operations that should share saves and analytics ownership. The middleware trims the string and requires a non-empty value.
* Public optional-auth list/detail routes do not require `x-guest-id`, but the video controller reads a supplied string header to project that guest’s `isSaved` value. It trims the value and ignores an empty/non-string value; this header alone does not authenticate access. A supplied invalid bearer still fails before this guest projection can be used.
* Do not send a guest identifier in the JSON body. The server derives identity from the auth middleware and stores it separately as `{type: "user"|"guest", id}`.
* User IDs and guest IDs are different identity namespaces. A user whose ID text equals a guest ID is still a different owner. Signing in does not migrate or merge guest saves or sessions. No migration endpoint or merge behavior is implemented.

Analytics validates user IDs as 24-character Mongo ObjectIds and guest IDs as non-empty strings of at most 256 characters. Saves/error reporting require the recognized identity type and non-empty ID, with no equivalent explicit 256-character service bound for the guest ID; the HTTP guest header remains the source. Generate and persist a stable guest ID in the app’s existing guest identity store; do not rotate it per request. Never use a playback-session ID as the guest ID.

Relevant source: [auth.middleware.js](D:/Projects/GitHub/petyard/src/domains/auth/auth.middleware.js), [publicVideo.controller.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.controller.js), and [videoAnalytics.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.validators.js).

### 3. Error envelope and shared constraints

Operational errors use this shared shape (the `status` value is typically `"fail"` for `ApiError`; status code is the HTTP status):

```json
{
  "status": "fail",
  "error": [
    {
      "code": "VIDEO_INVALID_PAGINATION"
    }
  ],
  "message": "Invalid pagination"
}
```
`error` can be an empty array for auth errors that do not carry a domain code. Unexpected production failures become HTTP `500` with a generic message and empty `error`; operational service errors intentionally avoid exposing database/provider details. Source: [errorMiddleware.js](D:/Projects/GitHub/petyard/src/shared/middlewares/errorMiddleware.js).

Unless an endpoint says otherwise, list pagination accepts query `page` and `limit`, defaults to `1` and `20`, requires positive safe integers, and caps `limit` at `100`. Invalid paging returns `422 VIDEO_INVALID_PAGINATION`. Pages are 1-based. A zero-result page still reports `totalPages: 1`.

The paged response fields are `totalResults: number` (all matching rows before paging), `totalPages: number` (ceiling of total divided by limit, or 1 for no rows), `page: number` (normalized 1-based page), `results: number` (count of items on this page), and `data: array` (the page items). This shape applies to YouTube/feed/saved lists and the daily report. Video list responses wrap it in `{data: <page>}`; the daily report returns `<page>` directly.

The public Videos master switch is `VIDEOS_PUBLIC_ENABLED`; Product Video public surfaces use the separate `PRODUCT_VIDEOS_PUBLIC_ENABLED` switch. When a switch hides a list, its response is an empty paged result. A hidden/unavailable detail or playback grant returns a not-found error. Analytics issuance follows the corresponding switch and existing media eligibility. Do not infer that these features are publicly enabled in deployment from local source acceptance.

### 4. Public listing, detail, and feed

#### YouTube list

`GET /api/v1/videos/youtube?page=1&limit=20`

Success: `200 {data: {totalResults, totalPages, page, results, data}}`. `results` is a number equal to the length of this page’s `data` array; it is not an array. The other paging values are numbers, and `data` is an array. Example: `{"data":{"totalResults":21,"totalPages":2,"page":1,"results":20,"data":[{"id":"...","kind":"youtube"}]}}` (item abbreviated). The list contains currently published YouTube videos. Ordering is explicit editorial position first, then position ascending, then publication time newest-first, then ID descending. If public Videos are disabled, it returns the same paging shape with zero results.

#### Mixed/public feed

`GET /api/v1/videos/feed?page=1&limit=20&kind=reel`

`kind` may be `reel` (default), `product`, or `all`; invalid values return `422 VIDEO_INVALID_KIND`. The source flags independently gate Reel and Product Video rows. `kind=all` mixes eligible enabled kinds in descending `feedAt`, then kind and ID ordering; Reel feed time is publication time, Product Video feed time is its ready timestamp. For `kind=reel` and `kind=product`, the respective eligibility and ordering rules still apply. A disabled/empty combination returns a zero-result page.

Only published Reel editorial content with its current ready asset/upload session appears as a Reel. Only an active product and ready current Product Video appears as Product Video. Product Video `showInReelsFeed` controls feed inclusion; it does not control presence in the product detail gallery or direct Product Video playback. Product Video deletion requested but not yet accepted by the provider can remain playable/listed; provider acceptance removes it. An inactive product is hidden.

#### Public detail

`GET /api/v1/videos/:id`

Success is `200 {data: <YouTube-or-Reel object>}`. Only published editorial YouTube or Reel objects are returned; Product Videos are served through product detail media and the separate Product Video playback route, not this editorial detail endpoint. Missing, hidden, invalid, or not-currently-ready content returns `404 VIDEO_NOT_AVAILABLE`.

#### Exact list/detail DTOs by kind

These are the fields currently constructed by the backend. Within each row below, fields are present on every response of that kind unless a nullable field is explicitly marked. Do not make one DTO require the union of fields. Every `id` is a string representation of a Mongo ObjectId. `title` is always a string: the server selects the requested language and falls back to English, then to the empty string. `description` is a string or `null`: localized value with English fallback, or null when empty. Send `Accept-Language` when the title/description should follow a language; a language change requires a fresh request because this API does not return both translations.

| Kind | Exact fields and types |
|---|---|
| YouTube (`kind: "youtube"`) | `id: string`; `kind: "youtube"`; `title: string`; `description: string|null`; `canSave: true`; `isSaved: boolean`; `publishedAt: ISO date-time string`; `coverUrl: URL string`; `youtubeId: 11-character string`; `embedUrl: URL string`. `coverUrl` is editorial cover URL or `https://i.ytimg.com/vi/{youtubeId}/hqdefault.jpg`; all keys are emitted. |
| Reel (`kind: "reel"`) | `id: string`; `kind: "reel"`; `title: string`; `description: string|null`; `canSave: true`; `isSaved: boolean`; `publishedAt: ISO date-time string`; `coverUrl: URL string|null`; `playbackHref: path string`; `durationSeconds: number`; `width: number`; `height: number`; `aspectRatio: number`. `coverUrl` uses editorial cover, then asset poster, then null. All keys are emitted. |
| Product Video feed item (`kind: "product"`) | `id: string` (Product Video placement ID); `kind: "product"`; `title: string` (localized parent product name); `description: null`; `coverUrl: URL string|null`; `productId: string`; `productHref: path string`; `playbackHref: path string`; `canSave: false`; `isSaved: false`; `durationSeconds: number`; `width: number`; `height: number`; `aspectRatio: number`; `attachedAt: ISO date-time string`. All keys are emitted. It has no `publishedAt`. |

`canSave` and `isSaved` are emitted for all list/detail DTOs, but product values are always false. Product Video gallery entries have their own smaller exact shape in [Product gallery use cases and field meanings](#product-gallery-use-cases-and-field-meanings) and do not include `isSaved`.

Example YouTube object (illustrative):

```json
{
  "id": "507f1f77bcf86cd799439011",
  "kind": "youtube",
  "title": "Care tips",
  "description": null,
  "canSave": true,
  "isSaved": false,
  "publishedAt": "2026-10-02T15:00:00.000",
  "coverUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "youtubeId": "dQw4w9WgXcQ",
  "embedUrl": "https://www.youtube.com/embed/dQw4w9WgXcQ"
}
```
Example Reel object (illustrative):

```json
{
  "id": "507f1f77bcf86cd799439011",
  "kind": "reel",
  "title": "Care tips",
  "description": null,
  "canSave": true,
  "isSaved": false,
  "publishedAt": "2026-10-02T15:00:00.000",
  "coverUrl": "https://media.example/reel-poster.webp",
  "playbackHref": "/api/v1/videos/507f1f77bcf86cd799439011/playback",
  "durationSeconds": 18,
  "width": 1080,
  "height": 1920,
  "aspectRatio": 0.5625
}
```
Example Product Video feed object (illustrative):

```json
{
  "id": "507f1f77bcf86cd799439012",
  "kind": "product",
  "title": "Ball",
  "description": null,
  "coverUrl": null,
  "productId": "507f1f77bcf86cd799439013",
  "productHref": "/api/v1/products/507f1f77bcf86cd799439013",
  "playbackHref": "/api/v1/product-videos/507f1f77bcf86cd799439012/playback",
  "canSave": false,
  "isSaved": false,
  "durationSeconds": 12,
  "width": 1920,
  "height": 1080,
  "aspectRatio": 1.7777777777777777,
  "attachedAt": "2026-10-02T15:00:00.000"
}
```
#### Meaning and use of every public Video field

The exact per-kind field sets above determine whether a field is present. This table explains the meaning of each field wherever that union member emits it. None of the public content objects is a request body to send back unchanged.

| Field | Meaning | Client use / retention |
|---|---|---|
| `id` | Editorial Video ID for YouTube/Reel, placement ID for Product Video | Retain with kind; use the matching detail/playback/save/analytics paths. |
| `kind` | Public content-family discriminator | Branch before decoding required fields or choosing player/permissions. Retain with ID. |
| `title` | Requested-language editorial title or parent Product name | Display; refetch on language change. Not an identifier. |
| `description` | Localized editorial description, or null; Product always null | Optional display; null is not the text "null". |
| `canSave` | Whether this content family supports saved association | Show save action for true; hide/disable for Product false. |
| `isSaved` | Current user/guest association state at read time | Drive save UI; refresh after identity or save mutation. Not global popularity. |
| `publishedAt` | Latest editorial publication time | Display/sort context; current eligibility remains server-owned. Parse full-server Cairo wire format. |
| `coverUrl` | Editorial cover, media poster, or YouTube thumbnail fallback per kind | Display preview image; null needs a local placeholder. Not an upload target or proof of current eligibility. |
| `youtubeId` | Current YouTube video key | Configure YouTube embed and bind a narrow player-error report; not the editorial ID. |
| `embedUrl` | HTTPS YouTube embed URL built from current YouTube key | Load through the supported YouTube/embed player. Do not load as HLS. |
| `playbackHref` | Application endpoint that issues a signed HLS URL | Request just before playback; retain as API path, never give this path directly to the media player. |
| `durationSeconds` | Backend-verified uploaded duration | Player progress/duration UI and analytics milestone expectations; do not submit duration as trusted metadata. |
| `width` | Verified source/transcoded media width in pixels | Layout and orientation together with height. Not the widget width or cover width. |
| `height` | Verified media height in pixels | Layout/orientation. Landscape and portrait video are both valid. |
| `aspectRatio` | `width / height` | Layout fit; less than one is portrait, greater than one landscape. Does not require a fixed crop ratio. |
| `productId` | Parent catalog Product ID | Retain for product navigation; distinct from this feed item's placement ID. |
| `productHref` | Product-detail API path | Fetch catalog detail for product navigation; not a canonical share/deep-link URL. |
| `attachedAt` | Product Video feed timestamp derived from the active asset's ready time | Display/order context; replacement can change it. It is not editorial publication or the initial reservation time. |

#### Product gallery use cases and field meanings

Product detail remains `GET /api/v1/products/:id`. The existing `images` field and its order/shape remain present for old clients. The response adds `media`, a derived ordered union of all existing images followed by the active ready Product Video placements ordered by placement position then ID. Product cards/list DTOs do not add `media`. If Product Video public is disabled, the existing images remain and `media` contains only those image projections. Product IDs are parent catalog IDs; each video gallery item’s `id` is the Product Video placement ID used by the product playback endpoint and analytics content ID.

Every gallery item has `id`, `type`, and zero-based `position`. The image projection always emits `public_id`, `url`, and `isMain` copied from that original image. The Product Video projection always emits all fields shown in its row:

| Union member | Fields and meaning |
|---|---|
| Image (`type: "image"`) | Exact shape: `id: string` (`image:{public_id}`); `type: "image"`; `position: integer`; `public_id: string`; `url: string`; `isMain: boolean`. |
| Video (`type: "video"`) | Exact shape: `id: string` (placement ObjectId); `type: "video"`; `position: integer`; `posterUrl: string|null`; `durationSeconds: number`; `width: number`; `height: number`; `aspectRatio: number`; `canSave: false`; `playbackHref: string`. No provider GUID, library ID, pending-asset key, signed URL, or save-state field is exposed. |

Example:

```json
{
  "images": [
    {
      "public_id": "products/ball/front",
      "url": "https://media.example/front.webp",
      "isMain": true
    }
  ],
  "media": [
    {
      "id": "image:products/ball/front",
      "type": "image",
      "position": 0,
      "public_id": "products/ball/front",
      "url": "https://media.example/front.webp",
      "isMain": true
    },
    {
      "id": "507f1f77bcf86cd799439012",
      "type": "video",
      "position": 1,
      "posterUrl": null,
      "durationSeconds": 12,
      "width": 1920,
      "height": 1080,
      "aspectRatio": 1.7777777777777777,
      "canSave": false,
      "playbackHref": "/api/v1/product-videos/507f1f77bcf86cd799439012/playback"
    }
  ]
}
```
The product detail route is `GET /api/v1/products/:id`, uses optional authentication, and returns the usual `200 {data: product}` envelope with both legacy `images` and the new `media`. It sets `Cache-Control: private, no-store`. Invalid supplied bearer tokens are rejected. For the player, branch on `type`: render the image URL for image, or fetch a Product Video playback grant using the `playbackHref` for video. Do not change gallery position based on an upload draft, feed selection, or client-side product availability guess.

The existing Product detail route also accepts optional query `warehouse`, a warehouse ObjectId; do not rename it `warehouseId`. This affects the existing Product availability/price context, rather than selecting a different video asset. Stock revision fields are granted by staff permission, not by an `includeStockRevisions` query.

#### Related batch Product detail projection

The existing `POST /api/v1/products/batch` also includes the same `media` union on each returned Product detail. It uses optional authentication, `Accept-Language`, optional stable guest identity, and optional query `warehouse`; other query keys are rejected. Send exactly `{"ids":["<product-id>"]}`. The array permits zero to 50 ObjectId strings, is deduplicated case-insensitively while retaining request order, and the JSON request is capped at 2,048 UTF-8 bytes. Success is `200 {data:{products:[...],unavailable_product_ids:[...]}}` with `Cache-Control: private, no-store`. `products` contains available full Product detail objects in deduplicated request order, each with existing `images` and the additional `media`; `unavailable_product_ids` lists requested IDs that cannot be returned under the current access rules. An empty request returns both arrays empty. An unavailable Product is not represented by a partial placeholder object. Responses over 2 MiB are rejected with 413 rather than truncated; reduce the batch size. Invalid body/query is 400; parser/request size errors can be 413. These are existing Products errors and may have no Videos domain code.

This is a related Products API, not an additional Videos route in the 53-route inventory. Its existing non-media Product fields retain the Products contract. See [productBatch.service.js](D:/Projects/GitHub/petyard/src/domains/product/productBatch.service.js), [productBatch.contract.js](D:/Projects/GitHub/petyard/src/domains/product/productBatch.contract.js), and [productBatch.constants.js](D:/Projects/GitHub/petyard/src/domains/product/productBatch.constants.js).

Implementation sources: [productMedia.service.js](D:/Projects/GitHub/petyard/src/domains/videos/public/productMedia.service.js), [publicProductVideo.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicProductVideo.repository.js), product detail mapping in [product.service.js](D:/Projects/GitHub/petyard/src/domains/product/product.service.js), and acceptance coverage in [productMedia.test.js](D:/Projects/GitHub/petyard/test/domains/videos/public/productMedia.test.js).

#### Sequenced customer flows: load, page, language, and deep links

These steps are client integration guidance; request sequencing, presentation, and retry UI are not implemented by the backend.

1. On first feed/list load, request page 1 with an explicit `Accept-Language` if the app has a selected language. Use `kind=reel` for the default Reel feed or the intended `kind` filter. Read `totalResults`, `totalPages`, numeric `results`, and array `data` as separate fields. If Product Video is enabled and desired, request `kind=product` or `kind=all`; the switch and eligibility rules remain server-owned.
2. To load another page, request the same list/filter with the next 1-based `page` and same `limit`. There is no cursor token. Append only a response belonging to the currently selected kind/language/page query; do not append an old response after the user has changed filter or language. A simple client request-generation/query-key check can prevent stale network responses from overwriting newer screen state. This is a client technique, not a server field.
3. When language changes, request the same content/list again with the new `Accept-Language`. The server returns one localized title/description value, not a bilingual object. Keep request identity and paging/filter values consistent; if a new query is in progress, do not let the old-language response replace it.
4. When opening a deep link to an editorial video, use its editorial `id` with `GET /api/v1/videos/:id`. For a Product Video, use the placement ID and retrieve its parent product detail or request its playback grant from the item’s `playbackHref`. A `404 VIDEO_NOT_AVAILABLE` means the content is no longer public/current, or a switch is off; stop playback attempts and show the client’s unavailable-content handling. The backend does not define that UI.
5. Do not assume `productHref`, `playbackHref`, or `embedUrl` is a stable shareable app deep link. They are API/player integration fields. These sources do not define a public web URL or app-link resolver.

### 5. Playback grant, expiry, and player lifecycle

#### Player choice and division of responsibility

The frontend does **not** need to implement a video decoding or streaming engine from scratch. Integrate an existing HLS-capable player using the frontend's established architecture, and connect its real playback callbacks to the Petyard flows below. No particular Flutter package, browser library, or player component is selected by this backend contract.

| Responsibility | Owner | Frontend integration consequence |
|---|---|---|
| Video processing, encoding, hosting, and CDN delivery | Bunny Stream | The frontend consumes the processed stream; it does not transcode video or implement CDN delivery. |
| Decoding, rendering, buffering, seeking, and supported stream-quality selection | Existing player library and platform playback engine | Pass the signed HLS URL to a compatible player. Confirm the chosen player's capabilities on the actual target platforms; the API does not guarantee a specific library's behavior. |
| Content eligibility, temporary playback grants, and analytics validation | Petyard backend | Request the current grant through `playbackHref`, respect expiry/unavailable responses, and use the documented analytics session and event APIs. |
| Reel/feed and Product gallery presentation, controls, lifecycle, recovery, and event collection | Petyard frontend | Integrate the player into the agreed screens and connect observed playback state to UI, source refresh, and analytics. Bunny does not implement these application flows automatically. |

For a Reel or Product Video, the basic client sequence is: read the content/gallery item → request its `playbackHref` with the application HTTP client → extract `data.url` and `data.expiresAt` → give `url` to the HLS player → observe actual playback callbacks → submit eligible analytics events through the separate analytics flow. `playbackHref` itself is an API path, not a playable media URL. Application bearer credentials stay on application API requests and must not be forwarded to Bunny/CDN media requests.

The frontend owns the integration of play/pause, mute, fullscreen, poster/loading/error states, and any controls agreed for the screen. These controls can reuse the chosen library's existing UI; custom controls do not require a custom playback engine. No fixed control layout, mute default, autoplay rule, or background-play product policy is imposed here. Recommended lifecycle handling is to pause a video when it leaves the active screen or the app enters the background, stop counting watch time, and reconcile state before resuming. A different background-playback requirement needs an explicit product and analytics decision; do not infer it from the existence of a playback URL. Swiping between Reels must not leave abandoned players playing or attributing events to the new item. Release player resources and listeners when their screen/item is disposed.

The client must also handle expired grants, source replacement, seek-position recovery where safe, and the measured analytics intervals described below. A player library or Bunny's own metrics does not automatically call Petyard's analytics endpoints. Customer sessions/events belong to actual customer playback; staff private previews do not issue customer analytics events.

Bunny also offers a ready-made **web iframe player**. Its embed URL and optional embed-token authorization are a different integration from a signed CDN HLS URL. The current Petyard public/preview contract returns HLS grants, does not return an authenticated Bunny iframe URL, and does not expose provider/library identifiers in public media DTOs. Do not construct an iframe URL from a public item, pass an HLS token as an embed token, or put a provider secret in the frontend. Switching to that player would require a separately agreed backend embed-authorization contract and verification that its callbacks can supply the required lifecycle/analytics observations. It is not a drop-in replacement for the present HLS contract. See [Bunny's embedding documentation](https://github.com/BunnyWay/documentation/blob/main/stream/embedding.mdx).

Editorial YouTube content uses its `youtubeId`/`embedUrl` with YouTube's supported embedded player, separately from Bunny and the native HLS player. Branch on `kind` before selecting the player. Use the YouTube event/error semantics in the following chapters; do not fabricate native HLS milestones or watch events for an embed that cannot supply the required observations.

Acceptance must include real browser/device playback, the available controls, off-screen/background/disposal behavior, expiry refresh, network interruptions, stale callbacks after changing content, and correct event attribution. Source/backend tests do not prove codec support, player-library compatibility, or Android/iOS/browser playback.

#### Reel grant

`GET /api/v1/videos/:id/playback` returns `200 {data: {url, expiresAt}}` with `Cache-Control: private, no-store`. Only currently published, verified-ready Reel media can receive a grant. The service checks eligibility, asks the configured provider for a signed HLS URL, then rechecks publication, active asset, upload session, and the feature switch before responding. An unpublish/replacement during signing fails closed as `404 VIDEO_NOT_AVAILABLE`.

#### Product Video grant

`GET /api/v1/product-videos/:id/playback` has the same response and cache policy. `:id` is the Product Video placement ID, not product ID or asset ID. It requires an active product, active placement slot, current matching active asset, ready technical state, provider status `4`, no accepted provider deletion, and enabled Product Video switch. Feed opt-in is not required. A pending deletion remains available until provider deletion acceptance; accepted deletion immediately makes it unavailable.

#### Grant fields and expiry

| Field | Type | Meaning |
|---|---|---|
| `url` | string URL | Provider-signed HLS playlist URL. Treat as a short-lived bearer capability: do not log, persist, share, put in analytics, or reuse as a stable identifier. Give it to the HLS-capable player. |
| `expiresAt` | ISO date-time string | Service expiry timestamp; full server currently serializes it as offsetless Cairo local time. Apply the shared wire-time parsing rule before comparing against current time; stop using/refetch when expired or on an authorization/media failure. |

Configured playback TTL is constrained to 60–900 seconds. The service builds provider expiry as an ISO timestamp, but the full-server Cairo JSON replacer currently removes its timezone marker; follow the shared wire-timestamp chapter; source does not fix a single TTL across deployments. The mobile app should use `expiresAt`, not assume 15 minutes. A typical full-server response is `{"data":{"url":"https://cdn.example/.../playlist.m3u8?token=...","expiresAt":"2026-10-10T15:15:00.000"}}` (the token above is illustrative; never log or persist a real signed URL). On expiry or a 401/403/404/playlist failure likely due to expiry, call `playbackHref` again and replace the player source. Do not retry a stale URL indefinitely. Public playback grants are separate from analytics sessions: a valid analytics session does not authorize HLS, and a signed HLS URL does not issue analytics session ownership.

The backend source and tests prove the grant contract and rechecks, not playback support on any particular device, codec, network, or HLS player. The code does not define a mobile navigation/background policy. Recommended integration behavior is to pause playback and stop watch-time accrual when playback is not actually advancing (including app background, navigation away, or paused state); resume by confirming player state and seek position before emitting new intervals. This is client integration guidance, not a server-enforced lifecycle hook.

#### Refreshing a grant while playback is active

When a signed URL expires, stop the current measured interval, request a new grant using the same content’s `playbackHref`, and replace the HLS source. If the player can preserve the current position safely for the same media, retain it; verify the new player is advancing before starting the next watch interval. A grant refresh alone does not require a new analytics session if the same content/media remains current and the original session is still unexpired. However, the client cannot inspect asset identity from the public DTO. If the grant becomes unavailable because the media was replaced/unpublished, stop retries and stop attributing old playback to that session. If the same logical content becomes eligible again and the client starts a new playback attempt, issue a new analytics session. Never move unacknowledged events tied to the old session onto a new session. The server rechecks the captured asset/upload session on ingestion, so events from a stale media generation fail as unavailable.

Sources: [publicReelPlayback.service.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicReelPlayback.service.js), [publicProductPlayback.service.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicProductPlayback.service.js); tests: [publicReelPlayback.test.js](D:/Projects/GitHub/petyard/test/domains/videos/public/publicReelPlayback.test.js), [publicProductPlayback.test.js](D:/Projects/GitHub/petyard/test/domains/videos/public/publicProductPlayback.test.js).

### 6. Save and unsave

Only editorial YouTube videos and Reels are saveable. Product Video list/detail/gallery representations say `canSave: false`, `isSaved: false`; there is no product save route or product save behavior. `PUT /api/v1/videos/saved/:videoId` requires a user or guest identity, and only a currently published eligible editorial Video can be saved. It returns `200 {data: {videoId, isSaved: true}}`. Repeating PUT is idempotent: it does not add a second save or a second save-addition metric.

`DELETE /api/v1/videos/saved/:videoId` removes the current identity’s save and returns `200 {data: {videoId, isSaved: false}}`. Repeating DELETE is idempotent and does not record another removal. A hidden video can still be unsaved; invalid/nonexistent IDs also resolve to false for removal if no current record exists. For `PUT`, unknown/not-published/unavailable returns `404 VIDEO_NOT_AVAILABLE`. Persistence errors return `503 VIDEO_SAVE_UNAVAILABLE`.

`GET /api/v1/videos/saved?page=1&limit=20&kind=all` is identity-protected. `kind` is `all` (default), `youtube`, or `reel`; other values return `422 VIDEO_INVALID_KIND`. The page envelope is the common paged response; each result uses the public item shape with `isSaved: true`. Hidden, removed, or no-longer-eligible items do not appear. Ordering is most recently saved first, then save-row ID. Disabled public Videos produces an empty page, not a save lookup.

Example:

```json
{
  "data": {
    "videoId": "507f1f77bcf86cd799439011",
    "isSaved": true
  }
}
```
Save analytics are server-owned state transitions. The backend emits `save_added` only when the unique save association is newly created and `save_removed` only when an association is actually deleted. Duplicate PUT/DELETE calls, editorial cleanup, and content deletion do not fabricate user transitions. The client must not post these event types to `/analytics/events`; the event validator does not accept save types from the client.

#### Save interaction sequence and retry boundary

For a save action, use the content DTO’s `canSave` and `id`, send PUT with the current identity, and apply the returned `isSaved` state. If the acknowledgement is lost, retry the same PUT: the operation is idempotent, and only the first actual transition counts. For unsave, use DELETE and apply false; repeating DELETE is also idempotent. If the UI allows rapid toggles on one item, serialize those operations per item or otherwise ensure the final server operation matches the latest user intent. The backend does not accept a client revision/sequence for saves, so concurrent opposite requests can arrive in either order. This serialization is client guidance, not an additional backend guarantee.

On guest-to-user sign-in, do not assume the returned user save list includes guest saves or that the guest state was migrated. Each identity has its own server-side association. If product requirements call for migration, this source has no endpoint or contract for it.

Sources: [publicVideo.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.routes.js), [publicVideo.service.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.service.js), [publicVideo.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.repository.js), and [videoSave.model.js](D:/Projects/GitHub/petyard/src/domains/videos/public/videoSave.model.js).

### 7. YouTube player error reporting

`POST /api/v1/videos/:id/player-errors` requires user/guest identity. It is for a YouTube video embed error, not arbitrary diagnostics or HLS playback telemetry. JSON body has exactly two keys:

| Key | Type / allowed values | Meaning |
|---|---|---|
| `youtubeId` | string, exactly 11 characters `[A-Za-z0-9_-]` | The YouTube ID the player actually tried to embed. Must still match the current published item’s linked YouTube ID. |
| `reason` | `unavailable` or `embedding_disabled` | The narrow client-observed failure class. |

Extra fields are rejected, including raw error text, stack traces, network response, reporter ID, URL, or device details. The `:id` must be a valid 24-hex editorial ID. Invalid shape returns `422 VIDEO_INVALID_PLAYER_ERROR`; stale/mismatched, hidden, non-YouTube, unpublished, or disabled content returns `404 VIDEO_NOT_AVAILABLE`. Successful response is `202 {data: {reported: true}}`, `Cache-Control: private, no-store`. Storage/outbox failures return `503 VIDEO_REPORT_UNAVAILABLE`.

Accepted reports create deduplicated staff notification-outbox alerts. Dedupe is by video, linked YouTube ID, UTC calendar day, and recipient; it does not disclose whether any eligible staff recipients exist, does not reveal reporter identity, and does not unpublish automatically. Staff review must verify the report before changing publication. Rate limit is 10 requests per 15 minutes per IP in the current limiter; excess returns `429 VIDEO_REPORT_RATE_LIMITED`. This limiter is local-process/IP based. Tests prove guest/user HTTP behavior, rejection of invalid bearer tokens, alert privacy, stale-link fencing, dedupe, and outbox rollback/retry.

Source: [publicVideo.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideo.validators.js), [publicVideoError.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideoError.repository.js); tests: [publicVideoPlayerError.test.js](D:/Projects/GitHub/petyard/test/domains/videos/public/publicVideoPlayerError.test.js).

### 8. Analytics issuance and client retention

Analytics is server-owned, session-bound, and accepted only for a current eligible item. It is not a client-maintained counter API.

#### Issue a playback session

`POST /api/v1/videos/analytics/playback-sessions`

Headers: `Content-Type: application/json` plus either `Authorization: Bearer ...` or `x-guest-id`.

Body permits exactly:

```json
{
  "kind": "reel",
  "contentId": "507f1f77bcf86cd799439011"
}
```
`kind` is exactly `youtube`, `reel`, or `product`; `contentId` is a 24-hex Mongo ID. For YouTube and Reel this is the editorial Video ID. For Product Video this is the Product Video placement ID, not the parent catalog Product ID. Unknown body fields (including `youtubeId`, `assetId`, URL, viewer ID) are rejected with `422 VIDEO_INVALID_PLAYBACK_SESSION`.

Success is `201 {data: {playbackSessionId, expiresAt}}`. `playbackSessionId` is an opaque UUID v4 generated by the server and bound to both current content media and the resolved identity namespace/value. `expiresAt` is a timestamp with explicit numeric offset, currently formatted with `+00:00`; retain and submit the session ID exactly. The server-defined lifetime is 30 minutes. There is no public endpoint that returns/decodes the captured asset/session metadata to the client. The server stores the current content ID, kind, relevant current asset ID/upload-session ID or YouTube ID, identity, issue/expiry, and event state. Do not make up a session ID, reuse a session for a different item, or copy it between guest and user identity.

The service rechecks content after creating the session and deletes it if the current published/ready media changed while issuance was in progress. An eligible session does not itself return a playback URL or grant. Reel/Product URL issuance must be done separately through the corresponding playback endpoint. YouTube uses the `embedUrl` and `youtubeId` from the public content object.

Unavailable/currently hidden/wrong-kind media, feature-off, expired or changed media returns `404 VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE`. Invalid identity returns `401 VIDEO_IDENTITY_REQUIRED`; persistence failure returns `503 VIDEO_ANALYTICS_UNAVAILABLE`. A per-IP limiter allows 120 session-issuance requests per minute and emits `429 VIDEO_ANALYTICS_RATE_LIMITED` when exceeded.

#### Data the client must retain

For each active playback attempt, retain these values in memory or a short-lived retry queue:

1. `kind` and the correct `contentId` (editorial Video ID or Product Video placement ID).
2. The server-returned `playbackSessionId` and its expiration. Do not persist it as a stable user or media key.
3. A fresh UUID for each event, reused exactly when retrying that same event. The same event ID with changed payload is a conflict.
4. Each event’s `occurredAt` and exact payload, so network retry sends identical logical event content. Equivalent timestamp offsets are normalized by the server, but changing duration, type, position, reason, or session ID is not an exact retry.
5. Playback state needed to measure actual advancing time without overlap: event time ordering, last submitted interval end, actual play start, cumulative played milliseconds, and last known player position. Client-side state is for truthful measurement; server independently validates it.

There is no client sequence-number field in the accepted event schema. Maintain chronology in the client queue and send events in chronological order; the server persists/validates `occurredAt` and rejects backward time within a session. Do not add a `sequence`, `seq`, or revision property: extra keys are rejected.

Stop queue retries after the session expires or identity changes. If app sign-in changes from guest to user, obtain a fresh session for the user identity. Do not copy guest session/event queues under the user identity. If a retry receives a conflict, fix the client’s event-ID reuse/payload mutation rather than changing payload under the same ID. If session is unavailable, get a new session only if content remains eligible; do not silently move stale queued events to the new session because `playbackSessionId` is part of the event payload and idempotency scope.

### 9. Analytics event submission

`POST /api/v1/videos/analytics/events`

Headers: `Content-Type: application/json` plus the same identity credentials used to issue the session.

Body must be `{ "events": [...] }`, with 1–50 events and UTF-8 JSON size at most 64 KiB. Each event contains `eventId`, `playbackSessionId`, `type`, `occurredAt`, plus only the type-specific property in the table below. Extra keys are rejected. `eventId` must be UUID-shaped; `playbackSessionId` must be UUID v4. Event IDs are unique within a playback session in storage.

| Event `type` | Required client fields | Rules and meaning |
|---|---|---|
| `impression` | none beyond common fields | Once counted per session. Issue session first and wait at least 1 second before an impression. This represents an actual displayed impression, not merely a feed response. |
| `play_start` | none | Actual playback begins; counted once per session. Starts the timing basis for later `watch_time` and `rebuffer`. |
| `progress_25` | `positionSeconds` number | Counts once when actual play position is at least 25% of server-known duration and submitted watch time is at least that much. |
| `progress_50` | `positionSeconds` number | Same rule at 50%. |
| `progress_75` | `positionSeconds` number | Same rule at 75%. |
| `complete` | `positionSeconds` number | Requires at least 95% admitted watch time and player position in the final second (position must be at least duration−1 and no greater than duration). Counted once per session. |
| `watch_time` | `durationMs` integer | Actual uninterrupted advancing-play interval, 1–10,000 ms. Never infer from wall-clock screen-open time, seek distance, paused time, background time, or buffering. Intervals must not overlap and cumulative duration cannot exceed server elapsed time since issuance. |
| `replay` | none | Actual replay action/start; counted once per session. For an additional independently measured playback, issue a new session to obtain a new server budget. |
| `share` | none | Share action. May be repeated and counted per accepted event (each distinct event ID). |
| `playback_error` | `reason` enum | `network`, `decode`, `unavailable`, `embedding_disabled`, or `unknown`. Client-observed general player error, not raw diagnostics. May be repeated. |
| `rebuffer` | `durationMs` integer | Actual buffering episode after `play_start`, 1–300,000 ms. Does not count toward watch time. Episodes cannot overlap play intervals or begin before actual playback. Initial loading is not rebuffering. |

Event timestamp format is ISO date-time with seconds, optional 1–3 fractional digits, and explicit `Z` or `±HH:MM` offset. It must be a valid calendar timestamp. Server accepts only an event no more than 5 minutes old or 30 seconds in the future; it must not predate session issuance by more than 30 seconds and must not move backward relative to previously accepted events in that session. Impression has the additional 1-second delay. For watch/rebuffer interval boundaries, duration is measured backward from `occurredAt`.

For each event, required common fields are:

| Field | Type | Meaning |
|---|---|---|
| `eventId` | UUID string | Client-generated stable idempotency key. Generate once, reuse for byte/semantic-identical retries; never reuse for a distinct event. |
| `playbackSessionId` | server-returned UUID v4 string | Session owner and media binding. It must belong to this request identity, remain unexpired, and still match current published/ready media. |
| `type` | enum above | Event classification. YouTube is limited to `impression`, `share`, and `playback_error`; other event types return `422 VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE`. |
| `occurredAt` | ISO date-time string with offset | Client observation time, subject to server clock-window/order checks. Use actual event time and preserve it on retries. |
| `positionSeconds` | finite number, milestone types only | Actual player position for progress/completion. Non-negative and no greater than server-known duration. Not accepted on other types. |
| `durationMs` | safe integer, timed types only | Actual interval length; max 10,000 for `watch_time`, 300,000 for `rebuffer`. Not accepted on other types. |
| `reason` | error enum, `playback_error` only | Coarse player error category. Not accepted on other types. |

#### Share event and shareable destination

The backend supports only an analytics action `type: "share"` (common fields only) on a playback session. It returns no share URL and has no dedicated share endpoint. When the user actually completes a share action, the client may record one share event under the active session using the normal event ID/timestamp/retry contract. The client must use an app/web destination already defined by the client product; do not share the signed HLS URL, an API playback grant URL, or invent a public route based on the API path. Current content DTOs provide `id` and, for product feed entries, `productHref`; they do not provide a canonical public share URL. A share event is optional analytics and does not itself share content.

The backend derives `kind`, `contentId`, `counted`, `qualifiedViewCounted`, `receivedAt`, expiry, and payload hash from session/state. These are not legal client fields. Client must never submit `kind`, `contentId`, asset IDs, `counted`, `qualifiedViewCounted`, aggregate counters, save events, user ID, guest ID, signed URL, raw stack/message, or provider details in an event.

Success: `200 {data: {accepted, duplicates}}`. `accepted` counts newly persisted event rows, including valid repeated semantic metrics such as multiple shares; `duplicates` counts exact event-ID retries already stored. A retry with the same ID and identical normalized payload increments duplicates and does not change reports. Reuse of an event ID with a different payload returns `409 VIDEO_ANALYTICS_EVENT_CONFLICT`. Per-session cap is 500 newly accepted events; exceeding it returns `409 VIDEO_ANALYTICS_SESSION_LIMIT`. Event HTTP limiter allows 60 requests/minute/IP and returns `429 VIDEO_ANALYTICS_RATE_LIMITED`.

Example native Reel event batch (values illustrative):

```json
{
  "events": [
    {"eventId":"e81c9a23-8eaf-4c5b-9d6d-7c6629c90e18","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"impression","occurredAt":"2026-10-10T12:00:01.000Z"},
    {"eventId":"99e7d35c-47e7-48f6-aefd-f9c9619f9804","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"play_start","occurredAt":"2026-10-10T12:00:02.000Z"},
    {"eventId":"3a27782e-f26e-4f72-9cdd-cdc2d18dd9f7","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"watch_time","durationMs":2000,"occurredAt":"2026-10-10T12:00:04.000Z"},
    {"eventId":"331442bd-e395-4537-884c-52e48b6f7d44","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"watch_time","durationMs":2500,"occurredAt":"2026-10-10T12:00:06.500Z"},
    {"eventId":"4c0c43ca-f50b-407b-8d5e-07c0529732f4","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"progress_25","positionSeconds":4.5,"occurredAt":"2026-10-10T12:00:06.500Z"},
    {"eventId":"616fb1ce-8c62-4ec0-8ab0-b1324b979efc","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"watch_time","durationMs":4500,"occurredAt":"2026-10-10T12:00:11.000Z"},
    {"eventId":"922386c6-a8ce-48b0-8aa9-088c535a7427","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"progress_50","positionSeconds":9,"occurredAt":"2026-10-10T12:00:11.000Z"},
    {"eventId":"3a1e2b14-0e50-47e0-b4b4-3a7ab8f5fd4d","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"watch_time","durationMs":4500,"occurredAt":"2026-10-10T12:00:15.500Z"},
    {"eventId":"b650b310-fb1f-45cc-ae43-e28c10278bc0","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"progress_75","positionSeconds":13.5,"occurredAt":"2026-10-10T12:00:15.500Z"},
    {"eventId":"df470218-ea1f-41b0-a3e8-a89b3c509d91","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"watch_time","durationMs":3600,"occurredAt":"2026-10-10T12:00:19.100Z"},
    {"eventId":"47019b64-2ef8-4e80-8fd9-e786ad32e60d","playbackSessionId":"f90f72ce-e9b0-4f92-a76e-249d484449c4","type":"complete","positionSeconds":17.1,"occurredAt":"2026-10-10T12:00:19.100Z"}
  ]
}
```

For this example, assume the session was issued at `12:00:00Z`, the item’s server-known duration is 18 seconds, and ingestion occurs at `12:00:19.100Z` or shortly afterward within the five-minute event window. The intervals are contiguous and sum to 17,100 ms; the first watch interval that takes cumulative watch time to at least 2,000 ms qualifies the view. The milestone positions and watch totals meet 25%, 50%, 75%, and 95%/final-second checks. Equal timestamps for a watch chunk and its immediately observed milestone are valid because the server rejects backward time, not equal time. UUIDs are illustrative and distinct.

Validation/storage errors include `422 VIDEO_INVALID_ANALYTICS_EVENTS`, `413 VIDEO_ANALYTICS_PAYLOAD_TOO_LARGE`, `422 VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE`, `404 VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE`, and `503 VIDEO_ANALYTICS_UNAVAILABLE`. Each batch is transactional across sessions/events/daily increments. Any invalid event in a batch rejects the batch; do not assume preceding events from that batch were partially accepted. Group events sensibly (up to 50, within size), retain exact events until the acknowledgement, then remove only the acknowledged/duplicate events from retry storage.

#### Playback, seeking, pause, background, and buffering integration

The API only accepts observed facts; it does not know the player state. Mobile code should emit `play_start` when playback really starts, `watch_time` only for measured intervals during which the player was advancing, `rebuffer` only for an actual stall after playback has started, and milestones only after both actual watched time and actual player position meet thresholds. A seek updates player position but earns no watch time. Seeking to the end cannot create progress/completion. Initial poster/loading time is not a rebuffer. Pause, stop, background, route departure, and player teardown end the current watch interval; do not keep counting while the app is hidden or playback is paused. Resume after a state check and begin a new measured interval. These are integration semantics implied by backend validation; no frontend implementation is proven here.

There is no requirement or server state for emitting `impression` on every list render. Emit only when the client’s product definition of displayed impression is actually met, and preserve the 1-second issuance delay. YouTube currently has no server-verified duration and therefore accepts no play-start/watch/progress/completion/rebuffer metrics. For YouTube, only impression, share, and coarse playback-error events are accepted; do not fabricate duration-based engagement.

#### Invalid batch and retry discipline

An analytics batch is transactional: a validation or session/media failure aborts the batch, including events earlier in that same request. A deterministic `422`/`404` response therefore does not mean some prefix was committed. Diagnose against the validator rules, event ordering, current identity/session, timestamps, actual watch intervals, and server-known media duration. Correct the source measurement and rebuild the batch before retrying. Keep each event ID attached to one observed action; never change a payload under an ID that might already have been accepted, and never allocate new IDs merely to bypass a conflict or make a rejected metric count. For a transport timeout where the server’s result is unknown, retry the exact same payload with the same IDs. The server returns exact duplicates for already-committed events and accepts any events that were not committed by a failed transaction. Once a batch is acknowledged, remove its exact events from the retry queue according to `accepted` plus `duplicates`.

Sources: [videoAnalytics.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.validators.js), [videoAnalytics.service.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.service.js), [videoAnalyticsIngestion.service.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalyticsIngestion.service.js), and [videoAnalytics.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.repository.js). Behavior tests: [videoPlaybackMetrics.test.js](D:/Projects/GitHub/petyard/test/domains/videos/analytics/videoPlaybackMetrics.test.js), [videoAnalyticsIngestion.test.js](D:/Projects/GitHub/petyard/test/domains/videos/analytics/videoAnalyticsIngestion.test.js), and [videoPlaybackSession.test.js](D:/Projects/GitHub/petyard/test/domains/videos/analytics/videoPlaybackSession.test.js).

### 10. Staff daily analytics report contract

`GET /api/v1/videos/analytics/reports/daily`

Requires `protect`, role `superAdmin` or `admin`; an Admin also must have enabled control `analytics`. SuperAdmin does not need that control. Guests and ordinary users are rejected. A permitted but unauthorized actor receives `403 VIDEO_FORBIDDEN`; auth failures follow normal auth middleware status. Query accepts only `kind`, `contentId`, `from`, `to`, `page`, and `limit`; unknown keys or wrong types return `422 VIDEO_INVALID_ANALYTICS_REPORT`.

| Query | Type / default | Meaning / constraints |
|---|---|---|
| `kind` | enum; default `all` | `all`, `youtube`, `reel`, `product`. |
| `contentId` | optional 24-hex ID | Editorial Video ID for YouTube/Reel; Product Video placement ID for product. Case normalized. |
| `from`, `to` | both omitted or both `YYYY-MM-DD` | Inclusive calendar-day range in `Africa/Cairo`. If omitted, `to` is today in Cairo and `from` is the preceding 29 days (30 calendar days total). Maximum span is 365 days difference; future `to` is not separately excluded by current validator. One without the other is invalid. |
| `page`, `limit` | common pagination; default 1/20 | Positive safe integers; maximum limit 100. |

Success directly returns:

```json
{
  "totalResults": 1,
  "totalPages": 1,
  "page": 1,
  "results": 1,
  "data": [
    {
      "day": "2026-10-03",
      "kind": "reel",
      "contentId": "507f1f77bcf86cd799439011",
      "metrics": {
        "impressions": 1,
        "playStarts": 1,
        "progress25": 1,
        "progress50": 0,
        "progress75": 0,
        "completions": 0,
        "replays": 0,
        "shares": 0,
        "playbackErrors": 0,
        "rebuffers": 0,
        "saveAdditions": 0,
        "saveRemovals": 0,
        "qualifiedViews": 1,
        "watchTimeMs": 5000,
        "rebufferTimeMs": 0
      }
    }
  ]
}
```
Pagination fields mean: `totalResults` is number of day/content/kind aggregate rows matching filters; `totalPages` is at least one; `page` echoes normalized page; `results` is number of rows in this page; `data` is the rows. Rows sort newest day first, then kind ascending, then content ID ascending. Empty date/content combinations return zero rows with `totalPages: 1`.

Each row’s fields:

| Field | Type | Meaning |
|---|---|---|
| `day` | `YYYY-MM-DD` string | Cairo local calendar date. |
| `kind` | `youtube` / `reel` / `product` | Content kind. |
| `contentId` | string ObjectId | Stable editorial ID or Product Video placement ID, matching session issuance semantics. |
| `metrics` | object | Every listed metric is integer count/duration or `null` when not implemented/applicable. `0` means metric is available and no counted event occurred; `null` means unavailable and must not be rendered as measured zero. |

Metric dictionary:

| Metric | Type | Counts |
|---|---|---|
| `impressions` | integer or null | Counted `impression` events. |
| `playStarts` | integer or null | Counted `play_start` events. |
| `qualifiedViews` | integer or null | First accepted watch interval that takes session cumulative server-accepted watch time to at least 2,000 ms. One per session. A short Product Video can complete without qualifying. |
| `progress25`, `progress50`, `progress75` | integer or null | First valid threshold event per session. Requires enough accepted watch time and position. Skipping a milestone does not synthesize it. |
| `completions` | integer or null | First valid `complete` per session; requires at least 95% accepted watch time and final-second position. |
| `replays` | integer or null | First replay event per session. |
| `shares` | integer or null | Counted share actions; multiple distinct share events may count. |
| `playbackErrors` | integer or null | Counted general playback-error events; distinct event IDs count separately. This is separate from staff YouTube error-report notifications. |
| `rebuffers` | integer or null | Counted valid rebuffer episodes. |
| `saveAdditions`, `saveRemovals` | integer or null | Actual server-owned save state transitions only. Duplicate operations and cleanup do not count. |
| `watchTimeMs` | integer or null | Accepted playback interval milliseconds, split across Cairo midnight when an interval crosses a day boundary. |
| `rebufferTimeMs` | integer or null | Accepted rebuffer milliseconds, attributed to the event’s Cairo day. |

There is no rebuffer ratio field or ratio definition in the current API. The report exposes `rebuffers` and `rebufferTimeMs` separately; clients must not present an API-defined ratio or silently choose a denominator. Any derived ratio would need a separately agreed product definition.

For YouTube, duration/play metrics are unavailable and returned as `null`: `playStarts`, `qualifiedViews`, progress, completions, watch time, replays, rebuffers, rebuffer time. YouTube-supported `impressions`, `shares`, `playbackErrors`, `saveAdditions`, and `saveRemovals` return integer values (including zero). For Product Video, `saveAdditions` and `saveRemovals` are `null` because product videos cannot be saved. Other metrics apply. Reels have all metrics available. Daily rows are retained for up to twelve calendar months after the end of their day; the cleanup TTL is asynchronous, and report reads exclude expired rows. Aggregate history survives content deletion and feature-flag disablement; it has no viewer/session/provider identifiers.

Errors include `422 VIDEO_INVALID_ANALYTICS_REPORT`, `403 VIDEO_FORBIDDEN`, and `503 VIDEO_ANALYTICS_UNAVAILABLE`. Report failures do not expose storage errors. The daily route is not a customer/mobile endpoint; it is included here because it is part of the requested analytics contract.

Source: [videoAnalytics.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.routes.js), [videoAnalytics.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalytics.validators.js), [videoAnalyticsDaily.policy.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalyticsDaily.policy.js), [videoAnalyticsDaily.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalyticsDaily.repository.js), and [videoAnalyticsDaily.model.js](D:/Projects/GitHub/petyard/src/domains/videos/analytics/videoAnalyticsDaily.model.js). Tests: [videoAnalyticsDaily.test.js](D:/Projects/GitHub/petyard/test/domains/videos/analytics/videoAnalyticsDaily.test.js).

### 11. Endpoint status and error-code index

| Endpoint | Success | Important endpoint errors |
|---|---|---|
| YouTube/feed/saved list | `200 {data: page}` | `401` auth if invalid optional bearer or missing required identity on saved; `422 VIDEO_INVALID_PAGINATION`; feed invalid kind: `VIDEO_INVALID_KIND`; saved invalid kind: `VIDEO_INVALID_KIND` |
| Public detail / Reel grant / Product grant | `200 {data: object}` / grant | `404 VIDEO_NOT_AVAILABLE`; optional invalid bearer `401` |
| Save / unsave | `200 {data: {videoId,isSaved}}` | `401`; save `404 VIDEO_NOT_AVAILABLE`; `503 VIDEO_SAVE_UNAVAILABLE`; `422 VIDEO_INVALID_PAGINATION` only for saved list |
| Player error | `202 {data:{reported:true}}` | `401`, `422 VIDEO_INVALID_PLAYER_ERROR`, `404 VIDEO_NOT_AVAILABLE`, `429 VIDEO_REPORT_RATE_LIMITED`, `503 VIDEO_REPORT_UNAVAILABLE` |
| Issue analytics session | `201 {data:{playbackSessionId,expiresAt}}` | `401 VIDEO_IDENTITY_REQUIRED`, `422 VIDEO_INVALID_PLAYBACK_SESSION`, `404 VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE`, `429 VIDEO_ANALYTICS_RATE_LIMITED`, `503 VIDEO_ANALYTICS_UNAVAILABLE` |
| Ingest analytics events | `200 {data:{accepted,duplicates}}` | `401 VIDEO_IDENTITY_REQUIRED`, `413 VIDEO_ANALYTICS_PAYLOAD_TOO_LARGE`, `422 VIDEO_INVALID_ANALYTICS_EVENTS`, `422 VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE`, `404 VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE`, `409 VIDEO_ANALYTICS_EVENT_CONFLICT`, `409 VIDEO_ANALYTICS_SESSION_LIMIT`, `429 VIDEO_ANALYTICS_RATE_LIMITED`, `503 VIDEO_ANALYTICS_UNAVAILABLE` |
| Daily report | direct `200` page envelope | `401` auth, `403 VIDEO_FORBIDDEN`, `422 VIDEO_INVALID_ANALYTICS_REPORT`, `503 VIDEO_ANALYTICS_UNAVAILABLE` |

For errors returned by the global middleware, an `ApiError` typically serializes as `{"status":"fail","error":[{"code":"..."}],"message":"..."}`. Rate-limit middleware uses the configured message object with the same `error` array and `message`, and sends standard `RateLimit-*` headers with legacy headers disabled.

### 12. Mobile integration acceptance matrix

This matrix is a contract checklist for a future client acceptance run. Source-level backend tests cover server behavior; they do not mean the mobile implementation has passed these rows.

| Scenario | Expected client behavior | Backend acceptance criterion |
|---|---|---|
| Anonymous public list/detail/playback with neither bearer nor guest ID | Continue as guest/anonymous; `isSaved` false | Public reads/grants do not require identity |
| Invalid bearer plus otherwise valid `x-guest-id` | Surface auth failure; do not fallback | `optionalProtect`/`protectUserOrGuest` rejects invalid supplied bearer |
| Guest save/session/events | Send same persisted guest ID in header | Same guest owns records; no body-supplied identity |
| Sign in after guest activity | Start a fresh user-owned session; treat guest saves separately unless a future migration is designed | User and guest namespaces do not merge |
| Gallery with images and Product Videos | Preserve legacy image consumers; render union by `type` and `position` | `images` unchanged; `media` images first, eligible videos appended |
| Product Video absent from feed but in detail | Keep it in product gallery | Feed opt-in does not gate gallery or direct playback |
| Product Video `canSave:false` | Hide/disable save action | No Product Video save endpoint/state |
| Reel/Product playback | Fetch `playbackHref` at playback time; pass only returned HLS URL to player | Grant is fresh, short-lived, no-store; eligibility rechecked |
| Signed URL expires or fails | Request a new grant and replace source; avoid infinite reuse/retry | Old URL is not extended by analytics; grant endpoint checks current eligibility |
| Navigation away/background/pause/seek | Stop watch-time accrual; only emit intervals for confirmed advancing playback; seek itself is not watch time | Overlapping or implausibly long time rejected; milestones require accepted watch duration |
| Buffering | Do not label initial load as rebuffer; count only actual stall after play start; stop watch interval | Rebuffer cannot precede play start, overlap, or add watch time |
| Retry after network loss | Persist exact event ID and payload; retry identical event under same identity/session | Exact retry returns duplicate count without double aggregation |
| Event changed after first attempt | Allocate a new event ID only if it is truly a distinct observation; otherwise correct retry implementation | Same ID with different payload returns `409 VIDEO_ANALYTICS_EVENT_CONFLICT` |
| Session expired/content changed | Stop retrying old events; acquire new session only for new observations | Old sessions fail closed; stale asset, publication, or product state is checked |
| YouTube playback telemetry | Restrict to impression/share/coarse error; do not infer time or completion | Unsupported duration event returns `VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE` |
| Player error report | Send only editorial ID, attempted YouTube ID, and allowed reason | No raw message/user metadata accepted; alert is deduped and review-only |
| Save retry | Treat PUT/DELETE as idempotent; refresh `isSaved` from response/list | Only real association transitions count in save metrics |
| Daily report rendering | Render `null` as “not available”; zero as measured zero | YouTube duration metrics/Product saves are null; Cairo day is local report boundary |

### 13. Evidence and remaining uncertainty

Backend evidence inspected for this chapter includes public route/controller/service/validators/repositories, Product Video playback and projection, Reel playback grant service, analytics routes/controllers/validators/session and event services/models/daily policy, auth middleware, shared error serializer, route mounting, and focused public gallery/playback/player-error/analytics unit and HTTP tests. The existing plan documents were used only as wayfinding/context; implementation claims were reconciled against current source/tests.

Local test coverage confirms the listed source behavior, including identity separation, auth rejection, product gallery compatibility, media eligibility, signed URL rechecks, event validation/idempotency/transactional aggregation, milestone and buffering rules, and Cairo daily aggregates. This chapter did not run tests; the cited tests are source evidence, not a new test run in this documentation task.

Remaining uncertainty to resolve in client/deployment acceptance:

* No mobile app source or client serialization/player integration was inspected or proven. This document cannot claim the Flutter/native player honors lifecycle, HLS, union decoding, or event queue behavior.
* No physical-device/browser codec, HLS expiry, background playback, or network-retry acceptance was performed.
* Public feature switches are off in the current environment, and local source has not been deployed to the VPS. The live route availability, production values, auth configuration, provider CDN signing, and deployed database/index state are not established here.
* Server acceptance does not determine product analytics policy for what counts as a displayed impression, nor does this source define client UI copy for null metrics or a particular background-playback product policy.


## Admin Editorial Videos and Reels

This chapter describes the current admin-facing Editorial Videos API: creating and reviewing YouTube videos and Reels, uploading or replacing Reel media, requesting previews, managing cover art and ordering, and monitoring provider work. It is written for a frontend implementer. It documents the server behavior currently present in source; it does not enable the upload or cover feature flags.

### Base paths, authorization, and response conventions

The editorial API base path is **/api/v1/videos/admin**. Provider-operation monitoring is mounted separately at **/api/v1/videos/admin/provider-operations**.

Every endpoint requires an authenticated admin or superAdmin. An admin additionally needs literal enabled control **videos**; superAdmin bypasses the control-list check. Approval, rejection, publishing, unpublishing, permanent deletion, and public-position changes are superAdmin-only. Submit is **admin-only in the service**, despite both roles passing the shared router. The Reel preview service also checks the role before contacting the provider. The service layer repeats important ownership and role checks; hiding a button in the client does not replace server authorization. Source enum constant names are implementation details and are not returned by the API.

Successful responses use a JSON object with a **data** property. Errors use the shared API error envelope with a status, an error array that can contain a stable code, and a message. Authentication, multipart parser, and unexpected failures may have an empty error array. Use the code when present and HTTP status for client behavior; do not build logic around message text.

Most session, preview, cover, list, and provider-operation responses set **Cache-Control: private, no-store**. The detail, metadata, and some ordering/review responses do not set that header in their controller. A client should still treat all admin responses as private and avoid shared caching.

IDs in URL paths are Mongo ObjectIds rendered as 24 hexadecimal characters. The API normalizes case for some IDs, but clients should retain the exact ID returned by the server. Editorial revision is an integer concurrency token. Send the revision from the latest response for draft/public ordering and permanent deletion, where the request schemas require it. Metadata PATCH does not accept or check a revision field. A successful mutation may increment revision; replace the client’s stored revision with the returned value.

#### Route and response inventory

All paths below are relative to the editorial base path unless the provider-monitoring base is shown.

| Method and path | Access | Success |
|---|---|---|
| GET / | Admin or superAdmin | 200, paginated editorial videos |
| PATCH /positions | superAdmin | 200, bulk public positions |
| GET /:id | Admin or superAdmin | 200, one admin video with cover URL enrichment |
| GET /:id/preview | Admin or superAdmin | 200, short-lived signed preview URL |
| POST / | Admin or superAdmin | 201, created YouTube video or Reel draft |
| POST /:id/upload-session | Admin or superAdmin; Reel-upload gate | 201 when issued, 202 while reserving |
| POST /:id/replacement-upload-session | Admin or superAdmin; Reel-upload gate | 201 when issued, 202 while reserving |
| GET /:id/replacement-upload-session | Admin or superAdmin | 200, current replacement upload status |
| POST /:id/replacement-upload-sessions/:sessionId/authorization | Admin or superAdmin | 200, renewed TUS authorization |
| POST /:id/replacement-upload-sessions/:sessionId/recovery | Admin or superAdmin | 201 when the replacement session is issued, 202 while recovery is running |
| DELETE /:id/replacement-upload-sessions/:sessionId | Admin or superAdmin | 202, cancellation accepted |
| GET /:id/upload-session | Admin or superAdmin | 200, current initial upload status |
| POST /:id/upload-sessions/:sessionId/authorization | Admin or superAdmin | 200, renewed TUS authorization |
| POST /:id/upload-sessions/:sessionId/recovery | Admin or superAdmin | 201 when the recovered session is issued, 202 while recovery is running |
| DELETE /:id/upload-sessions/:sessionId | Admin or superAdmin | 202, cancellation accepted |
| POST /:id/submit | Admin only in service; own record/proposal and valid state | 200, submitted video or proposal |
| POST /:id/approve | superAdmin | 200, approved video or applied proposal |
| POST /:id/reject | superAdmin | 200, rejected video or proposal |
| POST /:id/publish | superAdmin | 200, published video |
| POST /:id/unpublish | superAdmin | 200, unpublished video |
| PATCH /:id/position | superAdmin | 200, updated public position |
| PATCH /:id/draft-position | Admin or superAdmin | 200, updated draft position |
| POST /:id/cover | Admin or superAdmin; cover gate; multipart | 200, updated video/proposal |
| DELETE /:id/cover | Admin or superAdmin | 200, updated video/proposal |
| DELETE /:id/pending-change | Admin or superAdmin; proposal-author rule | 200, video with proposal removed |
| DELETE /:id | superAdmin | 202, permanent deletion accepted |
| PATCH /:id | Admin or superAdmin | 200, updated video or pending proposal |
| GET /api/v1/videos/admin/provider-operations | superAdmin | 200, filtered provider-operation page |
| POST /api/v1/videos/admin/provider-operations/:operationId/retry | superAdmin | 202, retry request accepted |

The route table lists 27 editorial endpoints and 2 provider-operation endpoints. The upload and cover routes exist in the router even though current default wiring leaves their readiness gates disabled; see the relevant sections below.

### Creating YouTube videos and Reel drafts

#### Create request

Send **POST /** with one of the following shapes. The request must contain only the listed fields.

YouTube:

~~~json
{
  "kind": "youtube",
  "youtubeUrl": "https://www.youtube.com/watch?v=abcdefghijk",
  "title_en": "English title",
  "title_ar": "العنوان",
  "description_en": "",
  "description_ar": ""
}
~~~
The kind may be omitted for YouTube. The service extracts and validates a single 11-character YouTube video ID from a supported HTTPS watch URL, Shorts URL, or youtu.be URL. It rejects credentials, explicit ports, fragments, playlists/multiple video IDs, and unsupported hosts. The backend verifies the video with YouTube before creating the editorial record. The client should retain the returned editorial **id**, **revision**, **status**, and any other fields returned by the current model serializer.

Reel:

~~~json
{
  "kind": "reel",
  "title_en": "English title",
  "title_ar": "العنوان",
  "description_en": "",
  "description_ar": ""
}
~~~
Kind is required for a Reel. Titles are trimmed, required, and at most 160 characters. Descriptions are optional, trimmed, default to an empty string, and at most 2,000 characters. Unknown keys are rejected. Do not send media IDs, provider IDs, cover URLs, or positions in the create body.

An admin-created YouTube video begins in **draft**. A superAdmin-created YouTube video is created **published** immediately after provider verification.

Every Reel starts as **draft**, including a Reel created by a superAdmin. Creation stores an automatic-publish policy on the record: admin-created Reels require editorial submission and review, while superAdmin-created Reels may auto-publish once their media is ready and a signed HLS preview has been verified. This policy is captured at creation; changing the user’s role later does not change the stored policy.

#### Editing metadata and review proposals

Use **PATCH /:id** for text edits. The request accepts the content fields relevant to the video kind and requires at least one editable field. The body must not include revision; the strict validator rejects it as an unknown field. For YouTube, the URL may be changed and is reverified. For Reel, only title and description fields are editable through this endpoint. Cover and media changes use their dedicated flows. Position fields are separate.

When an unreviewed draft is edited, the current draft content changes. For a video already approved, published, or unpublished, an admin edit creates or updates one **pendingChange** proposal rather than changing the live content. The proposal records its author, status, content snapshot, and review timestamps/reason. A second proposal is not created in parallel. An admin cannot edit a proposal owned by a different admin. A superAdmin may make direct changes under the service’s review-state rules.

The detail representation may include **pendingChange**. This schema-backed object has the following fields; optional fields can be omitted rather than serialized as null:

| Field | Type and meaning |
|---|---|
| authorId | Required user ObjectId. The admin allowed to submit or cancel this proposal. |
| status | Required review status: draft, in_review, or rejected. |
| content | Required proposal snapshot; nested fields are described below. |
| reviewReason | Optional string, at most 500 characters; set on rejection and cleared when edited or resubmitted. |
| createdAt | Required Date timestamp for this proposal; retained while that proposal is edited or resubmitted. |
| updatedAt | Required Date timestamp of the latest proposal edit or binding update. |
| submittedAt | Optional Date of latest submission; may be cleared when the proposal is edited or replacement upload is reserved. |
| reviewedAt | Optional Date of latest proposal review. |
| uploadSessionId | Optional Reel upload-session ObjectId for a replacement. Retain this exact ID for status, authorization, recovery, and cancellation routes. |
| assetId | Optional Reel asset ObjectId bound to the replacement session. This is not the provider GUID. |
| autoApplyWhenReady | Boolean, default false. For replacements, set from the role of the user who started that replacement: a superAdmin-started replacement may auto-apply when verified; an admin-started replacement requires review. This is separate from the top-level initial-media policy. |
| nextPreviewProbeAt | Optional Date for deferred signed-HLS verification. |
| rejectedAssetExpiresAt | Optional Date; normally rejection time plus seven days for a rejected Reel replacement. Resubmission clears it. |
| coverUrl | Detail-only enrichment, not stored in the proposal schema; usable pending-cover URL or null. |

The nested **content** object has required **kind** (youtube or reel), required **title_en** and **title_ar** strings (maximum 160 characters), and **description_en** and **description_ar** strings (default empty, maximum 2,000 characters). YouTube content requires **youtubeId**, an 11-character ID. Reel content cannot reference a YouTube ID. **coverId** is an optional cover ObjectId and can be null to represent removal. A replacement Reel’s asset/session references are on pendingChange itself, not inside content.

The admin video response is currently based on the model representation. The repository removes internal **_id**, **__v**, and **associationRevision**, and presents **id** as a string. It otherwise returns model fields, including nullable or optional fields where present. Do not assume this is a narrowly allowlisted public DTO. Frontend code should read the documented fields and tolerate additional fields and absent optional values.

The principal video fields are:

| Field | JSON type and nullability | Meaning and client handling |
|---|---|---|
| id | String; always present | Editorial video ObjectId rendered as a string; use in subsequent paths. |
| kind | String enum; always present | youtube or reel; determines content and media rules. |
| title_en, title_ar | Strings; required | Localized titles. |
| description_en, description_ar | Strings; normally present, default empty | Localized descriptions. |
| youtubeId | String for YouTube; absent for Reel | YouTube video ID. |
| activeAssetId | ObjectId serialized as string; optional | Current Reel media asset reference; absent/null when no media is attached. |
| activeUploadSessionId | ObjectId serialized as string; optional | Upload session bound to the current active Reel generation. After replacement application, this can be the applied replacement session; it does not imply initial-upload route eligibility. |
| activeCoverId | ObjectId serialized as string; optional | Current cover reference. |
| coverUrl | String or null; detail enrichment only | Usable active cover URL. Not stored editorial data and absent from list results. |
| status | String enum; always present | draft, in_review, approved, published, or unpublished. |
| authorId | ObjectId serialized as string; always present | User who authored the record. |
| autoPublishWhenReady | Boolean; present with schema default | Immutable creation-time initial-Reel policy. |
| nextPreviewProbeAt | ISO date string; optional | Scheduled signed-HLS verification retry time. |
| reviewerId | ObjectId serialized as string; optional | Most recent reviewer. |
| reviewedAt | ISO date string; optional | Most recent review time. |
| reviewReason | String; optional | Rejection explanation. |
| publishedAt, unpublishedAt | ISO date strings; optional | Editorial transition timestamps. |
| position | Number or null; optional | Public manual ordering value. Null clears manual ordering. |
| draftPosition | Number or null; optional | Independent draft-list ordering value. |
| pendingChange | Object, null, or absent | One proposal object; fields are detailed above. |
| revision | Number integer; always present | Optimistic-concurrency token for ordering/deletion; metadata PATCH does not accept it. |
| createdAt, updatedAt | ISO date strings; present | Record timestamps. |

The API may expose fields not listed in this table because of model pass-through. Do not persist or send internal Mongoose fields such as **__v** or **associationRevision**.

### Reel upload sessions

#### Feature readiness and current behavior

New initial/replacement Reel upload sessions require both `REEL_UPLOADS_ENABLED=true` and `REEL_UPLOAD_PIPELINE_READY=true`. Multipart cover upload requires `VIDEO_COVER_PIPELINE_READY=true`. The pipeline switches default to false when absent; the operator enables them after checking persistence, worker and provider prerequisites. They attest release activation and do not continuously measure worker health. The encrypted 2026-10-10 release environment enables these switches, but the VPS must still pull the release and restart its processes. Disabled Reel creation returns **503 VIDEO_UPLOAD_DISABLED**; disabled cover upload returns **503 VIDEO_COVER_DISABLED**. A client should treat these responses as temporarily unavailable and avoid tight retry loops. Status, authorization refresh, recovery, cancellation and cover removal remain available subject to their normal access and validation requirements.

#### Starting an initial upload

When enabled, create an initial session with **POST /:id/upload-session**. The target video must be a Reel draft. Admins may upload only their own draft; superAdmins can administer the flow subject to state checks.

Request:

~~~json
{
  "file": {
    "filename": "clip.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 12500000
  }
}
~~~
Send an **Idempotency-Key** header with the request; it must be 8–128 trimmed characters. The file object permits only **filename**, **mimeType**, and **sizeBytes**. Filenames are limited to 160 characters and cannot contain path separators or control characters. Accepted types are MP4/video/mp4 and MOV/video/quicktime. Size must be a positive safe integer no larger than 250 MiB. The server stores a fingerprint and binds the key to actor, purpose, and file metadata. Reusing the same key with different file metadata or for a different purpose is a conflict.

The server reserves the session before calling the provider. It persists the provider GUID before issuing a TUS upload URL. An uncertain provider creation does not cause the client to create a second resource; the server records recovery work and blocks conflicting attempts. For an already-reserving request, **202** can return a response with status **reserving** and no upload grant yet.

Once issued, the response is:

~~~json
{
  "data": {
    "videoId": "64f000000000000000000001",
    "sessionId": "64f000000000000000000002",
    "status": "awaiting_upload",
    "upload": {
      "endpoint": "https://video.bunnycdn.com/tusupload",
      "expiresAt": 1790000000,
      "headers": {
        "AuthorizationExpire": "1790000000",
        "AuthorizationSignature": "signed-value",
        "LibraryId": "library-id",
        "VideoId": "provider-video-id"
      },
      "uploadUrl": "https://video.bunnycdn.com/tusupload/opaque-resource",
      "resourceExpiresAt": 1790003600
    }
  }
}
~~~
The timestamps in the upload grant are Unix seconds. **expiresAt** is the short-lived authorization expiry. **resourceExpiresAt** is the original provider resource deadline and cannot be extended by refreshing authorization. The client must retain **videoId**, **sessionId**, **uploadUrl**, and **resourceExpiresAt** while the upload is active. Treat authorization headers and the TUS URL as sensitive transient upload credentials; do not put them in analytics, logs, crash reports, or durable client preferences.

The backend has already created the TUS resource. **endpoint** identifies the TUS service, but the client must PATCH the returned **uploadUrl**. It must not POST to the endpoint to create a second resource. Use the returned headers on the upload request as required by the TUS provider. The client should preserve upload progress locally and only request a fresh authorization grant when needed; it should not create a replacement session merely because the short-lived authorization expires.

Repeated use of the same idempotency key and same file can return the same current session and resource URL with newly computed, expiring authorization headers, subject to the session and original resource deadlines. A different key does not grant permission to create another active generation.

#### Status polling and refresh

Use **GET /:id/upload-session** for initial media or **GET /:id/replacement-upload-session** for replacement media. The status response contains:

| Field | Meaning |
|---|---|
| videoId | Editorial video ID. |
| sessionId | Current relevant session ID, or null if there is no current session. |
| status | none, applied, cancelled, failed, reserving, awaiting_upload, processing, ready, recovering, or deleting. |
| videoStatus | Current editorial state of the video. |
| failureCode | Stable failure code or null. |
| canRefresh | Whether the current upload authorization can be refreshed now. |
| abandonAt | Original upload-abandon deadline as an ISO timestamp or null. |
| recovery | Optional recovery summary with id, status, and failureCode. |

Poll at a moderate interval while the session is active and back off for failures or when status is not progressing. The provider callback and worker also advance processing; a client must not infer readiness only from a completed TUS upload. **ready** means the server has verified the provider state. For an auto-publish Reel, the server also needs a valid signed HLS preview before publication.

Use **POST /:id/upload-sessions/:sessionId/authorization** (or the replacement route) to refresh authorization for the existing TUS resource. This does not allocate a new provider video or TUS resource. The response contains the refreshed **upload** grant and the same session/resource identity. Refresh is rejected when the session is no longer current, the resource or abandon deadline has expired, deletion has started, or the server cannot establish that refresh is safe.

#### Upload recovery

Use the recovery POST for a known session when the client must resume after the existing resource has been confirmed absent. Send the same file metadata shape and an **Idempotency-Key** for the recovery attempt. The session ID in the path remains the identity of the recovery operation. Recovery is not a general “try again” endpoint: the server checks provider status and TUS absence, stores cleanup, and waits for the old resource’s durable cleanup before creating another resource.

The recovery POST uses the original **sessionId** in the path and preserves that same session ID in every response. Its first accepted call returns **202** with status **recovering** while old-resource cleanup is pending. After the cleanup operation completes, replay the same POST with the same idempotency key and file metadata. The server may then create and issue the new resource under that original session ID and return **201** with status **awaiting_upload** and an **upload** grant. This POST can take provider actions; the status GET is read-only and returns status fields only. Polling status alone does not create the new resource or return a new grant. The server preserves the original abandon deadline. If provider state is uncertain, the request remains retryable or returns a conflict/service error; do not issue another create from the client.

If the recovery POST response is lost, replay the same POST with the same recovery key and file metadata. The durable recovery record makes replay safe; a different key is not a way to bypass an unresolved attempt. A known provider GUID is compensated through durable cleanup. An unknown creation outcome is recorded and blocks further attempts until guarded recovery resolves it.

#### Cancellation

DELETE the relevant upload-session path to cancel. A **202** response means cancellation and durable cleanup were accepted, not that the provider resource has already been removed. Continue polling status or allow the backend worker to finish. Do not tell an operator that media is deleted merely because the request returned 202.

Initial-upload cancellation and replacement cancellation have different ownership effects. Cancelling an initial draft upload can cancel the draft’s media setup. Cancelling a replacement must preserve the currently active media generation. The server’s generation and owner checks are authoritative; clients should retain both the editorial video ID and the exact session ID in all cancel/status/refresh/recovery calls.


#### Exact session response fields and status interpretation

Initial/replacement create and authorization refresh return **videoId** (editorial ID), **sessionId** (the bound session), **status**, and an **upload** grant only when issued. Create can instead return **reserving** with no upload, HTTP 202. The complete upload grant/header field dictionary and HEAD/PATCH sequence are in the shared Product/TUS chapter; the provider shape is the same for Reels, but Reel file metadata has no clientId or showInReelsFeed field.

Recovery POST returns **videoId**, the **same original sessionId**, **recoveryId**, **status:recovering|awaiting_upload**, and **upload** only when awaiting_upload. Keep recoveryId for correlation; it has no public GET route. Recovering is HTTP 202 without a resource grant; awaiting_upload is HTTP 201 with a fresh resource. Replace the old URL/authorization and start the exact original file from offset zero on the new resource. Do not carry the old offset. Original filename/MIME/size must match the session manifest; original session abandonment deadline stays unchanged. A provider video still in upload status with resumable/complete TUS is not eligible just because a client grant expired.

GET status returns **videoId:string**, **sessionId:string|null**, **status:string**, **videoStatus:editorial enum**, **failureCode:string|null**, **canRefresh:boolean**, **abandonAt:ISO timestamp|null**, and optionally **recovery**. The recovery object is exactly **id:string**, **status:waiting_cleanup|reserving|issued|failed**, **failureCode:string|null**. None of these GET fields contains authorization or a newly issued resource. Status GET never allocates media or finishes recovery by itself. Resume/recovery requires its explicit POST.

| Session response status | Meaning / next action |
|---|---|
| none | No current matching session. Refetch Video/pending proposal; do not upload to a previously detached generation. |
| reserving | Provider setup has not issued a resource. Poll/replay the original create key; no client provider allocation. |
| awaiting_upload | Current asset can await bytes. canRefresh still determines refresh eligibility; grant resource and abandonment limits also apply. |
| processing | Provider processing or readiness prerequisites incomplete. Stop sending completed bytes and poll. |
| ready | Current verified-ready generation. Editorial Draft/Approved is still separate; review/Publish or automatic HLS fence applies. |
| applied | A replacement session has already been applied. Do not resume/cancel it as pending; refresh active Video and discard old transient upload state. |
| failed | Setup/upload/processing failed. Show failureCode; refresh detail and current/pending generation before choosing new work. |
| cancelled | Session failed with VIDEO_UPLOAD_CANCELLED and was cancelled. Local cancellation does not imply immediate external cleanup. |
| deleting | Current asset is in cleanup; do not send bytes. |

The enum includes recovering, but the current GET status implementation derives its primary status from session/asset. During recovery it may show awaiting_upload/deleting while its nested recovery is waiting_cleanup/reserving. **Use the nested recovery fields and recovery POST result**, not an expectation that GET always returns recovering. Cancel response is exactly **{videoId,sessionId,status:cancelled}** under data, HTTP 202, for either purpose. Refresh response is exactly **{videoId,sessionId,status:awaiting_upload,upload}** under data, HTTP 200.

CanRefresh false can mean expired resource/deadline, changed binding, processing, non-Draft initial Video, failed/cancelled session, or deletion intent. It is not a promise that a new upload is allowed. New sessions/duplicate-key replay/refresh/recovery have different conditions; reconcile the authoritative detail plus both purpose-specific status routes. No upload status history API is implemented.

### Replacement media and published-media preservation

Create replacement media with **POST /:id/replacement-upload-session** using the same idempotency and file shape as an initial upload. A replacement is bound to the current editorial video and pins the previous active asset generation. It does not immediately replace the current media.

While the replacement uploads, the active ready asset remains the one used for the current public or preview experience. The server accepts a replacement only if the expected current generation still matches. If the active generation changes while a new provider resource is being created, adoption is rejected and the new resource is scheduled for cleanup. Clients should refresh detail and replacement status after conflicts; they must not treat the new TUS upload URL as a committed media replacement.

For an admin-authored replacement on an already reviewed video, the replacement is part of a pending proposal. The admin submits that proposal for superAdmin review. Approval atomically applies the replacement and retires the old generation through provider operations. Rejection retains the proposal for resubmission during a seven-day media grace period; the rejected replacement asset receives a server-side expiry timestamp. If the proposal is cancelled or expires, cleanup is durable and the currently published/active asset remains protected.

A superAdmin-created Reel with the immutable top-level automatic-publish policy may apply its initial media after verification and signed-HLS preview, without a separate review. Replacement policy is independent: the replacement reservation stores **pendingChange.autoApplyWhenReady** and the session’s policy from the role of the replacement-session requester. A superAdmin-started replacement may be auto-applied after verification even if the Reel was originally created by an admin; an admin-started replacement remains a review proposal even if the Reel was originally created by a superAdmin. The server also checks the expected video/media generation before applying either kind of automatic change.

### Submission, review, publication, and retries

#### Submit

Call **POST /:id/submit** as an **admin** to submit the current draft or an eligible pending proposal. The author must be the submitting admin for an admin-authored record/proposal. Current state must allow submission; an in-review item cannot be submitted again. The service verifies YouTube content or Reel asset readiness before changing status to **in_review**. Admin-created Reel drafts must have a verified ready asset before submission. A Reel proposal’s media is checked instead of the live asset.

The request has no required body fields in the route. Do not attach content changes to submit; use PATCH first. The service rejects superAdmin submission with 403 VIDEO_FORBIDDEN even though the router lets the role reach the service. For initial manual submission the admin must be the record author; for a proposal the admin must be the proposal author. Automatic proposals cannot be manually submitted. SuperAdmin-created media follows its automatic publication/application flow, and the reviewer uses approve/reject for a submitted admin proposal.

#### Role and state action guide

| Actor and current state | Allowed action and result |
|---|---|
| Admin, editable draft | Edit current content; submit only if the admin is the record author and media/content verification passes. Initial Reel upload is owner-fenced to the author. |
| Admin, in_review | Cannot edit or resubmit; wait for review. |
| Admin, approved/published/unpublished item | Text and cover edits create a proposal; active content remains unchanged until approval. |
| Admin, own proposal in draft or rejected | Edit proposal, upload/replace proposal media where permitted, submit for review, or cancel it. |
| Admin, another admin’s proposal | Cannot edit, submit, or cancel it. |
| Admin, auto-apply proposal | Cannot edit or submit it as a manual proposal. |
| SuperAdmin, in_review item | Approve or reject it. |
| SuperAdmin, approved/unpublished item | Publish it; superAdmin may also unpublish a published item. |
| SuperAdmin, reviewed item without a conflicting proposal | May make direct editorial changes under service rules. |
| SuperAdmin, replacement proposal started by superAdmin | Replacement may auto-apply when media/HLS verification and generation checks pass. |
| SuperAdmin, any proposal | May cancel it; approval/rejection of a pending proposal still requires it to be in_review. |

This guide summarizes service authorization. The router also requires authentication and the admin/superAdmin role; admin needs literal control videos, while superAdmin bypasses that control-list check; review routes further restrict access to superAdmin.

#### Approve and apply

Call **POST /:id/approve** as a superAdmin. For a new submitted video, approval moves **in_review** to **approved**. Approval does not publish a newly created video.

For a pending proposal on an already reviewed video, approval verifies and applies the proposal. For a Reel replacement, the apply operation atomically switches the active asset and relevant content/cover references while preserving the current generation until that transaction succeeds. Old media and cover cleanup is queued durably. If the video was already published, approved replacement/content remains published according to the current workflow. If the video was unpublished, approving its proposal does not silently republish it.

#### Reject and resubmit

Call **POST /:id/reject** as a superAdmin with:

~~~json
{
  "reason": "Please replace the opening shot."
}
~~~
Reason is required after trimming and limited to 500 characters. A rejected new submission returns to draft and records the review reason, reviewer, and review time. A rejected proposal remains a proposal with status **rejected** and review metadata. For a rejected Reel replacement, the rejected asset is retained for up to seven days to allow correction and resubmission. The client should show the reason and use the same proposal context; it should not assume that the rejected asset is immediately deleted.

#### Publish and unpublish

Call **POST /:id/publish** as a superAdmin to publish an **approved** or **unpublished** item. The server rechecks content/media before publication. A new admin-created item therefore follows draft → in_review → approved → published. A superAdmin-created YouTube item may begin published; a superAdmin-created Reel begins draft and may auto-publish only after media/HLS verification.

Call **POST /:id/unpublish** to move a currently published item to **unpublished**. This changes editorial availability and timestamps; it does not instantly revoke signed URLs already issued to clients or erase CDN cache entries.

The controller returns the updated video under **data** with HTTP 200 for submit, approve, reject, publish, and unpublish.

#### Cancel pending proposal

Call **DELETE /:id/pending-change** to cancel the current proposal. An admin may cancel a proposal they authored; a superAdmin may cancel it regardless of author. The route does not accept content fields. For proposals with Reel upload bindings, cancellation uses the lifecycle cleanup path and preserves active media. A successful 200 response means the proposal was removed from editorial state; provider cleanup may still be pending.

### Cover images

#### Upload contract and current gate

The upload route is **POST /:id/cover**, multipart form data with exactly one file field named **cover** and no text fields. The route accepts one file, with at most two multipart parts, and limits the upload to 5 MiB. Current default router wiring has the cover gate disabled, so the route returns **503 VIDEO_COVER_DISABLED** until that gate is deliberately enabled.

When enabled, the server checks the actual image bytes rather than trusting the MIME header. Accepted source formats are JPEG, PNG, and WebP. Animated/multi-frame content is rejected. The image must be portrait after orientation is applied, must not exceed 16 million pixels, and must fit the 5 MiB limit. The server auto-orients and converts it to WebP quality 80 inside a maximum 1080×1920 box, preserving aspect ratio and without enlarging a smaller image. It does not require an exact 9:16 source or crop every portrait to 9:16. The backend generates the cover ID/object key. The client cannot choose a storage key, cover ID, or public URL.

Do not use metadata PATCH to change a cover. The cover is an asset with an upload/settlement lifecycle and durable cleanup. The server can return a **coverUrl** on detail responses when the cover is attached, settled, and not being deleted. List responses do not enrich cover URLs. A pending proposal may also include **pendingChange.coverUrl**.

Cover upload and reference changes are transactionally associated with the editorial record. The server reserves an unattached cover with an owner and deadline, then attaches it only if the expected record/generation still matches. Unattached or superseded covers are cleaned by provider operations after reference checks. A completed local detach does not prove that every CDN edge has already evicted the old object; old public cover URLs may remain cached.

#### Remove cover

Call **DELETE /:id/cover** with no body fields. For an editable draft the current cover can be removed; for a reviewed video the change is staged as a pending proposal. The route returns 200 with the updated video/proposal. The route itself does not use the cover-upload readiness gate.

Cover removal means the editorial reference was changed. Object deletion is a durable provider operation and may finish later. Keep the prior response state until the API confirms the detach, and do not assume cache invalidation from a successful response.


#### Cover-specific failures and cleanup diagnostics

| Code | HTTP / visibility | Meaning and client action |
|---|---|---|
| VIDEO_EDITOR_REQUIRED | 403 operational | Cover staging actor is not a valid admin/superAdmin. Check authenticated account; do not retry with fabricated actor fields. |
| VIDEO_COVER_UPLOAD_FAILED | 422 or 502 operational | Actual staging/upload failed. 422 represents invalid content; 502 provider/upload failure. Refresh current cover/proposal before another upload because allocation outcome may be uncertain. |
| VIDEO_COVER_PERSISTENCE_FAILED | 503 operational | Uploaded cover settlement could not be recorded. Retain editorial context; refresh, and do not assume no object was uploaded or attached. Backend sweeps unattached work. |
| VIDEO_COVER_STORAGE_CHANGED | Internal store validation, generally wrapped by staging failure | Storage identity no longer matches reservation. Do not change client metadata to override backend storage. |
| VIDEO_COVER_STATE_CONFLICT | Internal settlement error, generally wrapped by persistence failure | Reservation/settlement raced. Refresh editorial state. |
| VIDEO_COVER_CLEANUP_TARGET_INVALID | Worker cleanup diagnostic | Invalid cleanup target binding. Operator investigation; no frontend direct storage DELETE. |
| VIDEO_COVER_DELETE_NOT_AUTHORIZED | Worker/operation diagnostic | Reference/ownership checks prevent destructive cleanup. Current referenced cover must stay protected. |
| VIDEO_COVER_UPLOAD_UNSETTLED | Worker/operation diagnostic | Upload settlement incomplete; cleanup cannot safely delete it yet. Wait/review durable work rather than force deleting. |

These internal diagnostic strings are not all guaranteed top-level HTTP error codes. The endpoint-specific operational envelope takes precedence. A multipart limit/unexpected-file error can instead return a shared 400 with an empty error array. Record only sanitized code/state in client diagnostics, never storage credentials/object tokens.

### Permanent deletion

Only a superAdmin can call **DELETE /:id**. The path ID must be a 24-character hexadecimal editorial video ID. The request body must contain exactly:

~~~json
{
  "revision": 12
}
~~~
**revision** is a nonnegative safe integer and is required to fence deletion against a concurrent editorial change. Unknown body fields are rejected. The endpoint is permanent; use unpublish or proposal cancellation when the desired action is reversible.

The service transaction removes the editorial record and its save rows, verifies ownership/reference relationships for all Reel assets and covers owned by that video, and records provider cleanup operations for media/posters/covers that still need cleanup. It also marks in-flight upload sessions failed with **VIDEO_DELETED** while preserving enough session/asset markers for late provider results to be compensated. Provider calls occur after database commit through durable operations.

Success is **202** with **{data:{videoId,status:"removed"}}**. This reports local editorial removal and accepted cleanup work; it does not mean Bunny or storage deletion has completed. The current repository treats an already-absent video as an idempotent no-op and the service still returns the same removed response. A stale revision or owned asset/reference conflict returns **409 VIDEO_STATE_CONFLICT**; malformed ID/body/revision returns **422 VIDEO_INVALID_DELETE**; role failure returns **403 VIDEO_FORBIDDEN**. After the response, use the provider-operation monitor for outstanding cleanup. Do not show the deleted video as recoverable based on an operation retry.

### Ordering and list behavior

#### List and filters

**GET /** supports **page** and **limit**. Defaults are page 1 and limit 20; page must be an integer at least 1, and limit must be an integer from 1 through 100. If neither kind nor status is supplied, the list can include all editorial records. If either filter is supplied, the supported filter is the draft workspace: **status=draft** together with **kind=youtube** or **kind=reel**. Invalid/incomplete combinations return 422 **VIDEO_INVALID_FILTER**.

The success payload is a pagination object inside **data**, with **totalResults**, **totalPages**, **page**, **results**, and **data**. **results** is a number: the count of rows on this page. **data** is the array of model-backed admin video records. For example, an empty page returns **results: 0** and **data: []**.

Draft lists sort explicitly positioned drafts first by **draftPosition**, then unpositioned drafts by creation time descending with ID as a stable tie-breaker. Public positions do not change draft order.

#### Draft ordering

Use **PATCH /:id/draft-position** with exactly:

~~~json
{
  "draftPosition": 3,
  "revision": 7
}
~~~
**draftPosition** is null or a nonnegative safe integer. Revision is required and must be a nonnegative safe integer below the maximum safe integer. The target must be a draft. Success is exactly **200 {data:{videoId,draftPosition,revision}}**, not the full admin Video object:

~~~json
{
  "data": {
    "videoId": "64f000000000000000000001",
    "draftPosition": 3,
    "revision": 8
  }
}
~~~
Match **videoId** to the existing admin Video's **id** and patch only **draftPosition** and **revision** in that cached record. Preserve its other fields; do not replace the whole record with this summary. The returned revision is the new backend revision for later conditional ordering/deletion. Draft positions are independent of public positions.

#### Public ordering

Use **PATCH /:id/position** as a superAdmin with exactly **{ "position": 3 }**. Position is null or a nonnegative safe integer. The target must currently be published. This single-item endpoint does not require revision in the body.

For an atomic batch, use **PATCH /positions** as a superAdmin:

~~~json
{
  "kind": "reel",
  "items": [
    {
      "videoId": "64f000000000000000000001",
      "revision": 4,
      "position": 0
    },
    {
      "videoId": "64f000000000000000000002",
      "revision": 8,
      "position": null
    }
  ]
}
~~~
The body has exactly **kind** and **items**. Kind is youtube or reel. Items must contain 1–100 unique records, all of the same kind. Each item has exactly a 24-hex **videoId**, a nonnegative safe-integer **revision**, and a **position** that is null or a nonnegative safe integer. Duplicate IDs are rejected case-insensitively. The operation is transactional: if one target is missing, not published, has the wrong kind, or has a revision conflict, the batch does not partially apply. The success response is **{kind,items:[{videoId,position,revision}] }** under **data**.

Public positions are separate namespaces per content kind. Null clears a manual position; it does not delete the video. Equal position values are not prohibited. Omitted videos are not shifted by the server. Public ordering uses positioned videos first in ascending position, then the existing publication-time and ID fallback order.

### Provider-operation monitoring

Provider operations are asynchronous durable work, including stream reconciliation, poster copying, video deletion, abandoned upload cleanup, deletion verification, and cover cleanup. A successful API mutation can commit local state before provider cleanup finishes. Use the operation monitor to explain and retry work; do not infer provider absence from a local detach or an accepted 202 response.

#### List operations

Call **GET /api/v1/videos/admin/provider-operations** as a superAdmin. Supported query parameters:

| Parameter | Type and default |
|---|---|
| page | Integer >=1; defaults to 1. |
| limit | Integer 1–100; defaults to 20. |
| status | Optional pending, running, needs_attention, or completed. |
| type | Optional reconcile, copy_poster, delete, abandoned_upload_cleanup, verify_deletion, or cover_cleanup. |

Unknown, duplicate, malformed, or invalid query parameters are rejected with 422 **VIDEO_OPERATION_INVALID_INPUT**. The response is **data** containing **totalResults**, **totalPages**, **page**, **results**, and **data**. **results** is a number counting rows on this page; **data** is the operation array.

Each operation result is a deliberately safe summary:

| Field | Meaning |
|---|---|
| id | Operation ObjectId string. Use in the retry path. |
| type | Provider operation category. |
| status | pending, running, needs_attention, or completed. |
| failedAttempts | Number of failed executions recorded. |
| createdAt, updatedAt | Operation timestamps. |
| nextAttemptAt | Scheduled retry time or null. |
| leaseExpiresAt | Current worker lease expiry or null. |
| completedAt | Completion time or null. |
| lastErrorAt | Last provider-execution failure time or null. |
| lastEnqueueErrorAt | Last queue-enqueue failure time or null. |
| lastErrorCode | Sanitized stable failure code or null. |
| lastEnqueueErrorCode | Sanitized enqueue failure code or null. |

Timestamps serialize as ISO date strings or null. Error codes are sanitized; unknown provider failures use a generic code. The summary intentionally does not return provider GUIDs, library IDs, asset/cover IDs, lease tokens, target payloads, dedupe keys, or credentials. Do not try to reconstruct those values in the client.

The worker uses leases and durable state. A queue enqueue failure is recorded and can be swept/re-enqueued. Reaching **needs_attention** means automatic retry has reached its configured limit, not that the operation is safe to abandon. The current service uses repeated backoff up to a one-day delay and moves persistently failing work to needs_attention after ten failed attempts. Completed operations are eligible for retention cleanup after 90 days.

#### Request a retry

Call **POST /api/v1/videos/admin/provider-operations/:operationId/retry** with an empty JSON object. The ID must be a 24-hex ObjectId. Only **needs_attention** operations can be manually retried. A successful retry request atomically returns the operation to **pending** and sets its next attempt to now; it does not reset **failedAttempts**, erase prior failure history, or directly call the provider.

Response:

~~~json
{
  "data": {
    "operation": {
      "id": "64f000000000000000000003",
      "type": "delete",
      "status": "pending",
      "failedAttempts": 10,
      "createdAt": "2026-10-10T13:00:00.000",
      "updatedAt": "2026-10-10T14:00:00.000",
      "nextAttemptAt": "2026-10-10T14:00:00.000",
      "leaseExpiresAt": null,
      "completedAt": null,
      "lastErrorAt": "2026-10-10T13:59:00.000",
      "lastEnqueueErrorAt": null,
      "lastErrorCode": "PROVIDER_ERROR",
      "lastEnqueueErrorCode": null
    },
    "queued": true
  }
}
~~~
The response is **202** whether enqueue succeeds or the operation is durably reset but queueing fails. **queued=false** means enqueue failed; the operation remains pending for the worker sweeper. A missing operation returns 404, an operation in any state other than needs_attention returns 409, invalid input returns 422, and a repository/service failure returns 503. After requesting retry, refresh the operation list and watch status; repeated clicks do not create independent provider operations.

### Error handling by endpoint family

Errors use the shared API envelope when the error middleware handles them, but authorization middleware and multipart parsing can reject before a domain service constructs a coded ApiError. The codes below are stable domain errors established by the current source. Authentication, control access, malformed JSON, and infrastructure errors may use application-wide behavior; do not assume every failure has a Videos-specific code.

| Endpoint family | Status and representative stable codes | Client handling |
|---|---|---|
| List | 422 VIDEO_INVALID_PAGINATION; 422 VIDEO_INVALID_FILTER | Correct query values; page >=1 and limit 1–100. |
| Create/edit metadata | 422 VIDEO_INVALID_METADATA or VIDEO_INVALID_YOUTUBE_URL; 422 VIDEO_YOUTUBE_UNAVAILABLE; 503 VIDEO_YOUTUBE_CHECK_UNAVAILABLE; 409 VIDEO_STATE_CONFLICT | Correct the submitted fields or wait for verification availability. Do not retry invalid content unchanged. |
| Detail and ordinary state changes | 404 VIDEO_NOT_FOUND; 403 VIDEO_FORBIDDEN; 409 VIDEO_STATE_CONFLICT | Refresh detail after conflict and verify actor/role for forbidden responses. |
| Submit/approve/publish with missing or unverified Reel media | 409 VIDEO_ASSET_NOT_READY; 409 VIDEO_STATE_CONFLICT | Wait for server verification or signed-HLS readiness, then retry the action. |
| Cover upload/removal | 422 VIDEO_INVALID_COVER; 503 VIDEO_COVER_DISABLED or VIDEO_COVER_STORAGE_UNAVAILABLE; 409 VIDEO_STATE_CONFLICT | Respect the disabled gate; correct image/body and retry only after refreshing state. Multipart parser errors may use transport-level errors instead. |
| Single, bulk, or draft position | 422 VIDEO_INVALID_POSITION; 404 VIDEO_NOT_FOUND; 409 VIDEO_STATE_CONFLICT | Reload positions/revision and resubmit the intended ordering. Bulk updates are all-or-nothing. |
| Permanent deletion | 422 VIDEO_INVALID_DELETE; 403 VIDEO_FORBIDDEN; 409 VIDEO_STATE_CONFLICT | Do not automatically retry with a fresh revision; reload and require a renewed delete action after conflict. |
| Preview | 403 VIDEO_FORBIDDEN; 422 VIDEO_INVALID_PREVIEW; 404 VIDEO_PREVIEW_NOT_AVAILABLE; 409 VIDEO_PREVIEW_NOT_READY or VIDEO_PREVIEW_CHANGED; 503 VIDEO_PREVIEW_DISABLED | See the preview-specific table. |
| Reel upload, refresh, recovery, cancel | 400 VIDEO_INVALID_MEDIA; 403 VIDEO_FORBIDDEN; 409 VIDEO_UPLOAD_CONFLICT or VIDEO_UPLOAD_RESOURCE_EXPIRED; 500 VIDEO_CLEANUP_PERSISTENCE_FAILED; 503 VIDEO_UPLOAD_DISABLED or VIDEO_PROVIDER_UNAVAILABLE | Replay the same idempotent request after uncertain outcomes; never start a second resource to resolve a timeout. Missing upload state may be 404 VIDEO_UPLOAD_NOT_FOUND. |
| Provider-operation list/retry | 403 VIDEO_FORBIDDEN; 422 VIDEO_OPERATION_INVALID_INPUT; 404 VIDEO_OPERATION_NOT_FOUND; 409 VIDEO_OPERATION_STATE_CONFLICT; 503 VIDEO_OPERATION_UNAVAILABLE | Refresh the monitor. Only retry needs_attention work; queued=false still leaves durable pending work. |

Treat 5xx responses as potentially ambiguous when an endpoint can commit durable work before the response is lost. For upload-session creation/recovery, replay with the same idempotency key. **Editorial POST / creation has no idempotency-key contract**: after a lost response, inspect the admin list/current work before an operator chooses to create again; blindly replaying can create a duplicate editorial record. Cover upload likewise has no client idempotency-key contract: refresh detail/proposal before another upload, which could create another cover reservation. For state changes, refresh detail/status before deciding whether another request is needed. For deletion and cleanup, consult durable operation state; a network timeout does not prove that the server did nothing.

### Client state and idempotency checklist

For each editorial video, retain **id**, **kind**, **status**, and latest **revision**. Replace local revision from every successful response. Only send it on endpoints whose request dictionary permits it: draft position, bulk public positions, and permanent deletion. Metadata PATCH and single public position do not accept it. On a concurrency conflict, refresh detail and reconcile the user's intended change instead of silently replaying stale content.

For each upload, retain the editorial video ID, upload session ID, purpose (initial or replacement), idempotency key, exact file fingerprint metadata, TUS upload URL while valid, and original resource/abandon deadline. Keep refreshed authorization headers only for the active upload request. Never create a fresh provider resource because a client timeout obscured the result; replay the same idempotency key or use the server recovery path.

For each pending proposal, retain the proposal author/context and poll the video detail/status rather than assuming that approval, rejection, cancellation, or provider cleanup completed from an HTTP request being accepted.

For provider cleanup, retain the operation ID returned or discovered in the operation list. A local record marked deleting/removed and a provider operation marked pending/running are different facts. Completed provider work is the server’s confirmation that the operation reached its terminal condition; provider-operation summaries intentionally do not expose the target GUID.

### Protected Reel preview

Call **GET /:id/preview** to request a signed playback URL for an admin preview. The optional query field **asset** accepts **active** or **pending** and defaults to **active**. Use **pending** when reviewing a replacement proposal; use **active** to inspect the current generation. The server authorizes admin/superAdmin before it probes the provider, checks that the selected Reel asset is verified ready, obtains a short-lived signed HLS URL, and rechecks that the selected asset/session generation did not change during the provider probe.

Success is HTTP 200 with **{data:{url,expiresAt}}**. **url** is the provider’s signed HLS URL. **expiresAt** is an ISO timestamp. The configured grant lifetime is bounded from 60 seconds through 900 seconds (15 minutes). The response sets **Cache-Control: private, no-store**. Apply the shared wire-timestamp rule to expiresAt (full server currently emits Cairo local time without an offset). Treat the URL as a bearer credential: do not persist it in public content, logs, analytics, or shared caches. Request a new preview URL when the current one expires.

| Failure | HTTP/code | Meaning and client response |
|---|---|---|
| Actor lacks permitted role or identity | 403 VIDEO_FORBIDDEN | Do not retry as the same actor; check authorization. |
| asset has an unsupported value | 422 VIDEO_INVALID_PREVIEW | Send active, pending, or omit the query. |
| No matching verified-ready Reel generation | 404 VIDEO_PREVIEW_NOT_AVAILABLE | The selected target is absent/not ready for preview. |
| Provider cannot produce a usable signed HLS grant | 409 VIDEO_PREVIEW_NOT_READY | Keep the editor state and retry later with backoff. |
| Asset/session changed while URL was being generated | 409 VIDEO_PREVIEW_CHANGED | Refresh detail/status, then request the intended generation again. |
| Stream preview configuration is unavailable | 503 VIDEO_PREVIEW_DISABLED | Preview is unavailable; do not tight-loop. |

Provider/network exceptions not normalized by these service cases are handled by shared error middleware and do not have a more specific stable preview code in this service.

#### Admin end-to-end examples and race checklist

For a new manual Reel: create draft → create initial session → existing-resource TUS upload → poll Ready → private active preview → admin Submit → superAdmin Approve → observe Approved still private → superAdmin Publish → customer detail/grant available when flag enabled. On rejection, the record returns to Draft with review reason; its author corrects content/media and submits again. A superAdmin cannot substitute a Publish call while an admin item is still Draft or In review.

For a published manual replacement: create pending replacement → keep current public media/cover visible → upload/poll pending Ready → private pending preview → edit pending metadata/cover as needed → proposal author Submit → reviewer Approve → atomic application preserving the current editorial status → refresh current preview/public DTO, discard old pending upload state → observe durable old-media/cover cleanup separately. Rejection keeps current content unchanged and allows resubmission before rejectedAssetExpiresAt; expiry cleanup may win a race with resubmission, so refresh after any 409/404.

For automatic initial/replacement work: superAdmin creates/starts the relevant generation → bytes complete → Ready prerequisites → backend signed-HLS probe → publication/application only if current binding and automatic policy still match. Denied/delayed playlist verification keeps the prior editorial/current-media state; client polling shows it has not published/applied yet. A private-preview success does not itself force publication. Late Ready or successful HLS results after cancellation/deletion/new generation must not resurrect detached media.

Exercise lost editorial create response (no idempotency guarantee), lost upload create/recovery response (same key), grant refresh before/after resource expiry, cancellation before/after media advances, other-admin proposal ownership, automatic proposal protection, unpublish during pending replacement, approve/cancel race, draft edit during HLS/review verification, cover upload with lost response and concurrent replacement/detach, last cover reference cleanup, deletion while initial setup is reserving/issued, duplicate permanent delete, single/bulk position conflicts, archived notification pointing to missing Video, worker/queue offline then recovery, and late screen responses after changing account/video. Keep current and pending media separate in all cases. No actual frontend acceptance is claimed by this source checklist.

### Source evidence and limits

This chapter was grounded in current route, controller, validator, service, model, repository, middleware, Reel upload/preview/lifecycle/binding, cover, provider-admin, and focused test source. The following files were checked:

- [routes.js](D:/Projects/GitHub/petyard/src/app/routes.js)
- [editorialVideo.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.routes.js)
- [editorialVideo.middleware.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.middleware.js)
- [editorialVideo.controller.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.controller.js)
- [editorialVideo.service.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.service.js)
- [editorialVideo.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.validators.js)
- [editorialVideo.model.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.model.js)
- [editorialVideo.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialVideo.repository.js)
- [editorialCover.service.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialCover.service.js)
- [editorialCover.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialCover.repository.js)
- [editorialCover.model.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialCover.model.js)
- [editorialCover.store.js](D:/Projects/GitHub/petyard/src/domains/videos/editorial/editorialCover.store.js)
- [reelUpload.service.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUpload.service.js)
- [reelUpload.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUpload.validators.js)
- [reelUpload.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUpload.repository.js)
- [reelUploadRecovery.service.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUploadRecovery.service.js)
- [reelUploadRecovery.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUploadRecovery.repository.js)
- [reelResourceRecovery.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelResourceRecovery.repository.js)
- [reelResourceRecovery.model.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelResourceRecovery.model.js)
- [reelPreview.service.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelPreview.service.js)
- [reelLifecycle.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelLifecycle.repository.js)
- [reelUploadBinding.js](D:/Projects/GitHub/petyard/src/domains/videos/reels/reelUploadBinding.js)
- [videoProviderAdmin.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderAdmin.routes.js)
- [videoProviderAdmin.controller.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderAdmin.controller.js)
- [videoProviderAdmin.service.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderAdmin.service.js)
- [videoProviderAdmin.validators.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderAdmin.validators.js)
- [videoProviderOperation.model.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderOperation.model.js)
- [videoProviderOperation.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/videoProviderOperation.repository.js)
- [errorMiddleware.js](D:/Projects/GitHub/petyard/src/shared/middlewares/errorMiddleware.js)
- [editorialVideoHttp.test.js](D:/Projects/GitHub/petyard/test/domains/videos/editorial/editorialVideoHttp.test.js)
- [editorialVideoDraftPosition.test.js](D:/Projects/GitHub/petyard/test/domains/videos/editorial/editorialVideoDraftPosition.test.js)
- [editorialVideoBulkPosition.test.js](D:/Projects/GitHub/petyard/test/domains/videos/editorial/editorialVideoBulkPosition.test.js)
- [editorialCoverLifecycle.test.js](D:/Projects/GitHub/petyard/test/domains/videos/editorial/editorialCoverLifecycle.test.js)
- [reelUploadHttp.test.js](D:/Projects/GitHub/petyard/test/domains/videos/reels/reelUploadHttp.test.js)
- [reelResourceRecovery.test.js](D:/Projects/GitHub/petyard/test/domains/videos/reels/reelResourceRecovery.test.js)
- [reelPreview.test.js](D:/Projects/GitHub/petyard/test/domains/videos/reels/reelPreview.test.js)
- [videoProviderAdmin.test.js](D:/Projects/GitHub/petyard/test/domains/videos/provider/videoProviderAdmin.test.js)

Source and fake-adapter tests establish route behavior, validation, persistence/CAS logic, and worker scheduling as implemented. They do not prove live Bunny behavior, actual browser TUS interoperability, CDN eviction timing, or production feature readiness. Current default router wiring keeps Reel upload and cover upload disabled. This chapter does not enable flags, perform provider requests, or promise that old public cover URLs are immediately evicted.

#### Points to confirm before frontend integration

1. The route and controller source was used for all listed HTTP status codes. Some service errors are mapped by shared middleware; this chapter lists stable codes only where the source establishes them clearly.
2. The admin video response is model-backed and passes through most schema fields. Optional Mongoose fields may be missing rather than explicitly null. The client should tolerate both and avoid treating unlisted fields as a stable contract.
3. Initial and replacement upload status response shapes are described from current service code. The exact set of optional recovery fields can vary with state.
4. Upload and cover routes are intentionally documented even though their default gates are off. A frontend should show unavailable state until a separately approved deployment enables them.
5. Public cover URLs may remain cached after detachment or deletion. The API does not establish CDN purge completion as part of the local editorial mutation response.


## Product Video administration

### Product Video endpoint inventory

All twelve routes below require an authenticated `admin` or `superAdmin`. Admin additionally needs literal enabled control `products` (`PRODUCTS` is the source constant name); superAdmin bypasses that control check. The parent `:id` is the catalog Product ID; `:videoId` is the Product Video placement ID. IDs in request paths must belong to that Product. Existing authentication also enforces the verified-phone condition. Use `Content-Type: application/json` for JSON bodies.

| Method | Exact route | Body / query | Success |
|---|---|---|---|
| GET | `/api/v1/products/:id/videos` | None | 200 `{data: [...]}` active-slot status rows |
| GET | `/api/v1/products/:id/videos/:videoId/preview` | Query `asset=active` (default) or `pending` | 200 `{data:{url,expiresAt}}` |
| POST | `/api/v1/products/:id/videos/upload-sessions` | `{files:[...]}` and `Idempotency-Key` | 201 `{data:[...]}` |
| POST | `/api/v1/products/:id/videos/:videoId/upload-authorization` | No body required | 200 `{data:...}` |
| POST | `/api/v1/products/:id/videos/:videoId/upload-recovery` | `{file:...}` and `Idempotency-Key` | 202 recovering or 201 awaiting upload |
| POST | `/api/v1/products/:id/videos/:videoId/replacement-upload-session` | `{file:...}` and `Idempotency-Key` | 201 `{data:...}` |
| POST | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-authorization` | No body required | 200 `{data:...}` |
| POST | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-recovery` | `{file:...}` and `Idempotency-Key` | 202 recovering or 201 awaiting upload |
| DELETE | `/api/v1/products/:id/videos/:videoId/replacements/:replacementId/upload-session` | No body | 202 `{data:...}` cancelled |
| DELETE | `/api/v1/products/:id/videos/:videoId/upload-session` | No body | 202 `{data:...}` cancelled |
| PATCH | `/api/v1/products/:id/videos/:videoId` | Exactly `{showInReelsFeed:boolean}` | 200 `{data:...}` |
| DELETE | `/api/v1/products/:id/videos/:videoId` | No body | 202 `{data:...}` deleting |

Only initial batch creation and new replacement creation use `PRODUCT_VIDEO_UPLOADS_ENABLED`. Disabled creation returns 503 `VIDEO_UPLOAD_DISABLED`. Authorization refresh, recovery, status, preview, cancellation, visibility, and deletion do not use that creation flag, but still need valid access and configured services. Turning off new uploads must not prevent the UI from reconciling/cancelling already-issued work. Public visibility separately uses `PRODUCT_VIDEOS_PUBLIC_ENABLED`. There is no client-readable flags endpoint.

### Product file request dictionary

Initial batch request example:

```json
{
  "files": [
    {
      "clientId": "selected-clip-1",
      "filename": "product-demo.mp4",
      "mimeType": "video/mp4",
      "sizeBytes": 10485760,
      "showInReelsFeed": true
    },
    {
      "clientId": "selected-clip-2",
      "filename": "detail.mov",
      "mimeType": "video/quicktime",
      "sizeBytes": 5242880,
      "showInReelsFeed": false
    }
  ]
}
```
| Field | Requirement | Meaning / later use |
|---|---|---|
| `files` | Array of 1–3 files | Reserve the whole requested batch. Existing occupied slots count toward the maximum of three Product Videos. |
| `file` | A single manifest on replacement/recovery | Same manifest fields, except `showInReelsFeed` is forbidden. The API receives metadata, not file bytes. |
| `clientId` | String, non-empty after trimming, maximum 100 characters | Stable selected-file correlation. Initial batch values must be unique as submitted. Reuse exactly for retries and recovery. |
| `filename` | String, maximum 160 characters; no slash, backslash, or control characters | Original safe filename ending `.mp4` or `.mov` case-insensitively. Retain exact value for recovery. Do not submit a full local path. |
| `mimeType` | Exact `video/mp4` for MP4 or `video/quicktime` for MOV | Must agree with extension. Do not replace with `application/octet-stream`. |
| `sizeBytes` | Safe integer 1–262144000 inclusive | Exact file byte length; maximum 250 MiB. TUS must upload that declared number of bytes. |
| `showInReelsFeed` | Optional boolean on initial batch only | Defaults to `true`. Feed inclusion does not hide media from Product gallery/direct playback. Preserve explicit `false`. |
| `Idempotency-Key` header | Trimmed string length 8–128 | Identifies one logical create/recovery request. Save before request. Reuse with original actor and identical manifest. |

The backend verifies transcoded duration and dimensions, not merely frontend metadata. Uploaded media must have positive duration no more than 90 seconds and valid dimensions. Portrait and landscape video are allowed; the portrait restriction applies to editorial cover images, not video bytes. Selecting a nominally short file does not guarantee acceptance if the provider reports a duration over 90 seconds. The client should preflight file size/type/duration when available, then show the backend result as final.

Initial batch fingerprinting includes the submitted file objects and their JSON ordering, plus actor identity. Send a stable minimal object, retain its exact serialized manifest, and do not inject optional fields on a replay. Do not change file order, `clientId`, visibility, size, or actor with the same key. Initial batch file validators do not provide a general promise that arbitrary extra fields are ignored for idempotency. Replacement fingerprinting uses actor, `clientId`, filename, MIME, and size; recovery has its own fingerprint including actor, target replacement, and file. Use identical documented payloads for every retry regardless of these implementation differences.

### Product creation response and TUS grant dictionary

```json
{
  "data": [
    {
      "clientId": "selected-clip-1",
      "productVideoId": "507f1f77bcf86cd799439012",
      "position": 0,
      "status": "awaiting_upload",
      "upload": {
        "endpoint": "https://video.bunnycdn.com/tusupload",
        "expiresAt": 1791626400,
        "headers": {
          "AuthorizationExpire": "1791626400",
          "AuthorizationSignature": "<temporary-signature>",
          "LibraryId": "<library-id>",
          "VideoId": "<provider-guid>"
        },
        "uploadUrl": "https://video.bunnycdn.com/tusupload/<opaque-resource>",
        "resourceExpiresAt": 1791626400
      }
    }
  ]
}
```
All example IDs, hosts, tokens, times, and byte sizes are illustrative. They are not credentials or fixtures to submit unchanged.

| Field | Type | Meaning and client handling |
|---|---|---|
| `data` | Array for initial batch | One successful grant per requested file; associate using `clientId`. No partial-success array is returned on failed setup. |
| `clientId` | String | Echoed original file correlation. Not included in authorization-refresh responses. |
| `productVideoId` | ObjectId string | Stable placement identity for this Product. Keep even when upload resource changes. |
| `position` | Non-negative integer | Product Video order allocated by backend. Monotonically allocated; gaps can remain after deletions. Not the mixed gallery index or an editable reorder token. |
| `status` | `awaiting_upload` on issued creation | Backend has issued an upload resource; bytes/processing/publication are not complete. |
| `upload` | Object, only when a usable issued grant is returned | Temporary provider upload instructions. Absence means do not start/resume bytes from that response. |
| `upload.endpoint` | URL | Provider TUS collection endpoint, included by signing adapter. Backend has already created/bound the resource; frontend must not POST here to allocate another resource. Use `uploadUrl`. |
| `upload.uploadUrl` | URL | Exact existing TUS resource for HEAD/PATCH. Preserve the full value; do not construct it from `VideoId`. |
| `upload.expiresAt` | Integer Unix seconds | Expiry of this authorization. Refresh can issue another signature for the same resource only while backend eligibility and resource/deadline permit. |
| `upload.resourceExpiresAt` | Integer Unix seconds | Original immutable resource authorization horizon stored by backend. Refresh does not extend it. Not the same as the 24-hour abandonment deadline. |
| `upload.headers` | Object of strings | Exact provider authorization headers. Attach these to TUS requests; replace all after successful refresh. |
| `headers.AuthorizationExpire` | Unix seconds encoded as string | Must match this grant's expiry. Do not edit it or locally extend it. |
| `headers.AuthorizationSignature` | String | Temporary provider signature. Sensitive; no application/server API key is exposed. |
| `headers.LibraryId` | String | Provider library scope. Protocol field only, not a Product/Video ID. |
| `headers.VideoId` | Provider GUID string | Protocol binding to the provider video. Never use as `productVideoId`, `contentId`, editorial `id`, or saved item ID. |

Default upload grant/resource horizon is six hours (configuration permits one to six hours). A successfully issued backend upload has a separate original 24-hour abandonment deadline. Refresh and nonresumable recovery do not reset that deadline. An upload resource can expire sooner than abandonment. Clients must use returned timestamps and responses instead of assuming configured defaults. Product status DTO does not expose the abandonment deadline; local elapsed time is only a UI hint and cannot override server decisions.

#### Exact TUS integration sequence (Product and Reel)

1. Validate local file availability and its original manifest. Request a backend-issued session with a persisted idempotency key. Do not upload bytes before this succeeds.
2. Configure the TUS library to **resume the provided resource**. Disable automatic creation of a new resource at `endpoint`. If the chosen library only supports POST-creation, adapt its documented existing-resource capability; do not manufacture another Bunny video/resource.
3. Send HEAD to `uploadUrl` with returned authorization headers and `Tus-Resumable: 1.0.0`. Read `Upload-Offset` and `Upload-Length`; compare declared length with the selected exact file. Offset must be an integer from zero through length. A mismatched length, offset beyond length, or malformed response is not a safe resume.
4. PATCH bytes beginning at the server-reported offset, using `Tus-Resumable: 1.0.0`, `Upload-Offset: <offset>`, `Content-Type: application/offset+octet-stream`, and all authorization headers. Read acknowledged `Upload-Offset` after each chunk. Chunk size is a client/network choice; the backend specifies no required chunk size.
5. On a lost PATCH acknowledgement, HEAD before sending another chunk. The provider may already have accepted it. Never advance local offset merely because bytes were sent, and never assume the entire chunk failed.
6. Offset conflict or parallel client upload: stop competing writes, HEAD, and resume from authoritative offset only with the same file. Keep one active uploader per resource. Do not resolve conflicts by POSTing a new TUS resource.
7. After offset equals length, bytes are complete. Stop PATCH, show processing, and poll backend status. TUS completion is not readiness: transcoding, verified duration/dimensions/resolutions, current-generation binding, and relevant editorial actions still apply.
8. Provider authorization error: consult returned expiry/current backend state; refresh via the corresponding backend authorization endpoint if still eligible, then HEAD the same URL. Resource missing/expired requires the recovery decision below; a 404 alone does not prove provider video absence.

The backend can deny refresh after media becomes processing/ready, cancellation, replacement, deletion, deadline expiry, or resource expiry. That is expected state reconciliation, not a reason to recreate blindly. Provider protocol errors are separate from JSON API errors; do not attempt to parse every Bunny response as the application envelope. Never issue direct provider management DELETE or attempt to terminate TUS from the frontend. Cancellation/deletion belongs to backend routes and durable cleanup.

### Product initial-upload flow

1. Fetch existing Product and active-slot Video statuses. Show maximum three active video slots, including reserving/awaiting/processing/deleting work. Local counts are advisory; the backend serializes reservation across admins and rejects excess with 409 `PRODUCT_VIDEO_LIMIT_REACHED`.
2. Select 1–3 files that fit available capacity. Give each a stable `clientId`. Save manifest, original bytes reference, actor, and one batch idempotency key before POST.
3. POST batch. Backend reserves all slots before provider setup. Success 201 means every returned resource is issued. Provider failure returns an error, with compensation/durable cleanup of known allocations; do not interpret it as a usable partial result.
4. Match response items to files and retain each placement/position/grant. Upload each exact file independently to its issued resource. A user can cancel an individual pending placement; the remaining files do not need to be discarded by the frontend.
5. Poll status. Initially `awaiting_upload`; provider worker can progress through `processing` to `ready`. An initial terminal failure/abandonment releases its slot and can disappear from active-slot list. Provider status 4 without valid positive duration/dimensions/resolutions stays non-ready (processing) unless an explicit terminal failure rule applies. Poster copying is separate asynchronous work; public DTOs allow a null poster and the frontend must show its fallback. A row being absent does not by itself identify the failure cause; retain any previous safe code and refresh Product media/capacity.
6. At `ready`, Product media becomes customer-eligible when Product/public conditions permit. Product Video has no editorial Submit/Approve/Publish action. Refresh Product detail/gallery and feed as appropriate. Do not call editorial Reel publish routes for a Product placement.

Batch retry is deliberately narrow. Same key/manifest replays issued grants only while every batch placement is still active and awaiting upload within the original deadline. After any placement processes, becomes ready, or is cancelled, replay can return 409. Use status and per-placement authorization routes to reconcile; batch POST is not a status endpoint. A request still reserving, a failed batch, actor mismatch, or changed manifest also conflicts. After an uncertain create outcome, refetch status and retry the original key where valid; do not automatically generate a new key and consume more capacity.

### Product admin status response dictionary and interpretation

```json
{
  "data": [
    {
      "productVideoId": "507f1f77bcf86cd799439012",
      "position": 0,
      "status": "ready",
      "showInReelsFeed": true,
      "failureCode": null,
      "replacement": {
        "id": "507f1f77bcf86cd799439013",
        "status": "awaiting_upload",
        "failureCode": null
      }
    }
  ]
}
```
| Field | Type | Meaning / action |
|---|---|---|
| `productVideoId` | ObjectId string | Placement identity, used as nested `videoId` and public playback/analytics content ID. |
| `position` | Integer | Stable Video ordering within Product. Do not renumber after removals. |
| `status` | Placement lifecycle enum | `reserving`, `awaiting_upload`, `processing`, `ready`, `deleting`, `failed`, `removed` are defined lifecycle values. This route selects active slots, so released failed/removed rows normally disappear. |
| `showInReelsFeed` | Boolean | Current feed opt-in. Separate from readiness and gallery visibility. |
| `failureCode` | String or null | Safe active-asset, cleanup, or previous replacement failure. Can coexist with `ready`; it does not always mean current media failed. |
| `replacement` | Optional object | Present when current placement has a bound pending replacement. Not a separate Product slot. |
| `replacement.id` | ObjectId string | Replacement entity ID for refresh/cancel/recovery. |
| `replacement.status` | Asset technical enum, or `reserving` fallback | Pending asset state: `awaiting_upload`, `processing`, `ready`, `failed`, `deleting`, `deleted`. It is **not** replacement entity status `issued/completed/cancelled`. |
| `replacement.failureCode` | String or null | Safe error of the pending asset. Keep current ready media usable unless its own state changes. |
| `recovery` | Optional object | A recovery currently attached to this placement. |
| `recovery.id` | ObjectId string | Recovery correlation ID; not an upload resource or replacement ID. |
| `recovery.status` | Recovery enum | `waiting_cleanup`, `reserving`, `issued`, `failed`. Different from placement and nested replacement status. |
| `recovery.failureCode` | String or null | Safe recovery setup error. |

No upload signature, URL, original filename, clientId, backend asset ID, replacement entity completion history, or abandonment timestamp is returned in this status list. Persist the required operation state when creation succeeds; refresh authorization by ID rather than expecting status to reconstruct the complete initial request. A `ready` row with replacement processing means **current media stays ready** while the new generation is being prepared.

| Observed state | Frontend next action |
|---|---|
| `reserving` | Show preparing, poll; do not create a duplicate allocation. |
| `awaiting_upload` without recovery | Resume exact TUS resource/file; refresh authorization if eligible. |
| `processing` | Stop sending bytes; show processing and poll. |
| `ready`, no replacement | Enable active preview, feed toggle, new replacement, explicit delete according to access. |
| `ready` with replacement | Show current video and separate replacement progress. Do not enable a second replacement or current visibility/delete mutation that backend rejects. |
| `deleting` | Show deletion pending. Current public playback can remain available until provider accepts deletion. Capacity may still be occupied. |
| Nested `waiting_cleanup` | Retry original recovery request with same key/file after a bounded delay. No upload grant yet. |
| Nested `reserving` | Recovery allocation underway; reconcile, do not change key. |
| Row absent | Refresh Product gallery/capacity; discard stale screen actions. Do not infer a new slot ID from previous position. |

### Product replacement flow

A replacement is a new media generation of the same placement, not an added slot. Product ID, placement ID, position, and `showInReelsFeed` stay the same. The currently ready media remains customer-playable while a pending replacement uploads/processes. There is no admin review or separate Product replacement publish operation; once the worker verifies a valid ready replacement and current bindings, it atomically switches active media and records old-generation cleanup.

1. Require current placement `ready` and no pending replacement/deletion. Select replacement file, persist a **new** replacement-operation key and exact manifest, without `showInReelsFeed`.
2. POST replacement session. Response is `{productVideoId,replacementId,position,clientId,status,upload?}`. Retain `replacementId`. An issued response has `status: awaiting_upload` and grant. A replay of a terminal replacement may return `completed`, `failed`, or `cancelled` without a grant; do not start bytes merely because HTTP is 201.
3. Upload to its returned resource. Status list distinguishes top-level current-ready state from nested pending technical state.
4. Refresh through replacement-specific authorization route: response `{productVideoId,replacementId,position,status:"awaiting_upload",upload}`; no `clientId` field. Never use initial authorization refresh for pending media.
5. When ready application wins, pending replacement disappears and active playback/gallery points to the new asset. Discard old transient upload state, refetch gallery, and obtain fresh playback/analytics sessions for changed media. Old server analytics sessions are bound to their original generation and cannot be transferred.
6. On pending failure or cancellation, keep displaying previous ready video. Refetch status; clear pending operation only after reconciling outcome. A failure code can remain on the ready placement.

Replacement create replay binds to original actor/file and current placement. In-flight `reserving`, changed binding, removed owner, or wrong Product conflicts. If an existing issued pending asset is no longer awaiting upload, a replay may return its technical state without grant. Do not treat replay as an authorization refresh after processing has begun.

Cancellation: DELETE replacement upload-session returns 202 `{productVideoId,replacementId,status:"cancelled"}`. Backend detaches pending generation and queues its cleanup without deleting current media. The same already-cancelled replacement supports replay when reached through the service. If readiness/cutover already won, cancellation can conflict: refresh and present the new current media rather than claiming it was undone. Current-media explicit delete and feed toggle require no bound pending replacement; cancel/reconcile that work first if those actions are intended. Whole Product deletion is a different existing owner flow and can defeat an in-flight replacement; a late Ready hint must not resurrect the deleted owner.

### Product nonresumable upload recovery

Recovery is for an issued upload that cannot resume its original resource, while its original backend deadline remains valid. It is not a retry of failed transcoding, a way to exceed duration limits, or a shortcut for any TUS error. Backend checks actual management/video ownership/status and, when the video exists in upload status 0, checks TUS HEAD with fresh server authorization. Existing incomplete/complete resumable TUS is rejected with 409 `VIDEO_UPLOAD_CONFLICT`. A provider management 404 can permit recovery; a client TUS 404 alone is insufficient evidence.

Initial recovery: POST `.../:videoId/upload-recovery`. Pending replacement recovery: POST `.../:videoId/replacements/:replacementId/upload-recovery`. In each case use `{file:<original manifest>}` and a new recovery-operation idempotency key. `showInReelsFeed` must be absent. Original `clientId` and filename must match their recorded values exactly, and manifest/actor must remain identical across recovery retries. The frontend must upload the original selected bytes, not substitute a different file under the same manifest.

| Response field | Type / occurrence | Meaning |
|---|---|---|
| `productVideoId` | Always string | Same placement being recovered. |
| `replacementId` | Only replacement recovery | Same pending replacement entity. |
| `recoveryId` | Always string | New logical recovery operation. Keep for correlation. |
| `position` | Always integer | Unchanged placement position. |
| `status` | `recovering` or `awaiting_upload` | `recovering` has no usable upload; `awaiting_upload` means fresh issued resource. |
| `upload` | Only awaiting-upload response | Same grant schema, but a new resource/provider binding. Replace old transient grant/resource state. |

1. First valid request records cleanup of the old resource/asset and returns **202 recovering without upload**. Display recovering, not progress 0 for a resource you do not have.
2. Retry the **same endpoint/key/file** after a bounded delay. Until cleanup is safely complete, response remains recovering; a concurrent preparing state can conflict. Do not POST to an imaginary recovery-ID route.
3. Only after durable old cleanup is eligible can backend prepare and issue new media/TUS. Response **201 awaiting_upload** includes the new grant.
4. Upload from offset **zero** to the new URL. Do not carry the old resource offset into this resource. Same placement/replacement/position/visibility and original abandonment deadline remain. For pending replacement, current ready media remains intact.
5. Reconcile failures through status and original recovery request. 503 provider error or 500 cleanup-persistence failure does not authorize an unbounded new key loop. Unknown external allocation results have backend recovery/attention handling; the frontend cannot repair them by calling Bunny directly.

`VIDEO_UPLOAD_RESOURCE_EXPIRED` on authorization refresh means the grant/resource horizon has passed. It does not itself promise recovery eligibility, and refreshing cannot extend the immutable horizon. Backend may reject recovery if the resource still exists or completed media could be processing. Confirm state through backend, offer cancellation/reconciliation/support when no recovery is available, and never keep refreshing a resource after it is known unusable.

### Product private preview, visibility, cancellation, and deletion

#### Private preview

GET preview with `asset=active` by default; use `asset=pending` only for a pending replacement. Success `{data:{url,expiresAt}}` has ISO expiry and `Cache-Control: private, no-store`. It is a temporary HLS preview grant, with no public analytics session or publication side effect. Do not emit customer metrics for staff previews.

Preview checks Products permission, matching Product/placement/asset ownership, ready verified duration/dimensions/status, and actual signed HLS playlist availability, then rechecks bindings after the probe. Invalid selection/ID returns 422 `VIDEO_INVALID_PREVIEW`; unavailable selection 404 `VIDEO_PREVIEW_NOT_AVAILABLE`; provider playlist not ready 409 `VIDEO_PREVIEW_NOT_READY`; selection changed during signing 409 `VIDEO_PREVIEW_CHANGED`; missing configured service 503 `VIDEO_PREVIEW_UNAVAILABLE`. On changed, refetch status; do not show a stale grant. Active preview may remain available during deletion request until provider deletion is accepted. Pending preview requires current placement ready, exact issued replacement, and no deletion intent. Pending ready may cut over quickly, so 404 pending can mean it is now active: reconcile instead of treating it as upload failure.

#### Feed visibility

PATCH with exactly `{showInReelsFeed:true}` or false. Success returns only `{productVideoId,showInReelsFeed}` within `data`. It requires current placement ready with no pending replacement. 400 `VIDEO_INVALID_VISIBILITY` covers an invalid value and extra/missing body keys. Visibility controls mixed/Product feed inclusion only. It does not revoke gallery/direct playback, delete bytes, or affect the existing Product's ordinary product visibility. Do not label this toggle “delete” or “hide from all customers.”

#### Cancel initial pending upload

DELETE `.../:videoId/upload-session` returns 202 `{data:{productVideoId,status:"cancelled"}}`. It requires an active awaiting-upload placement with no pending replacement. It releases the slot/removes the pending placement and durably records cleanup. This is not the delete-ready-video route. If media already advanced/cancellation already removed the row, repeat may return 409; refetch and treat achieved absence as reconciled cancellation, without claiming provider cleanup instantly completed. Pause local TUS work as soon as cancellation starts so the app does not continue sending bytes into a cancelled generation.

#### Delete ready placement

DELETE `.../:videoId` returns 202 `{data:{productVideoId,status:"deleting"}}`. It accepts current ready placement only, with no pending replacement. UI should show deletion requested and stop offering edits. The slot remains occupied and current public media can remain available until provider delete acceptance. Once provider accepts deletion, backend removes public placement/releases slot; verified management absence and related cleanup can complete later. Repeating while deleting can conflict; reconcile status rather than creating another deletion. No client “force delete”, immediate CDN purge, or undo endpoint exists. Cached poster/cover URLs can remain readable after origin deletion; do not test deletion success by a public CDN image GET alone.

### Product endpoint error/action matrix

| Code / HTTP | Trigger | Frontend response |
|---|---|---|
| `VIDEO_INVALID_MEDIA` / 400 | Invalid IDs, key, file count/metadata/type/size | Correct request; no automatic unchanged retry. |
| `VIDEO_INVALID_MEDIA` / 400 | Strict recovery request body | Remove unexpected keys and send exactly the required file object. |
| `VIDEO_INVALID_VISIBILITY` / 400 | Strict visibility request body or invalid boolean | Send exactly one boolean `showInReelsFeed` field. |
| `PRODUCT_VIDEO_LIMIT_REACHED` / 409 | Concurrent/current slots exceed three | Refetch statuses/capacity; explain limit. |
| `VIDEO_UPLOAD_CONFLICT` / 409 | Stale lifecycle/binding, key mismatch, deadline, cancellation/readiness race, resumable recovery target | Refresh and reconcile. Do not generate a new key automatically. |
| `VIDEO_UPLOAD_RESOURCE_EXPIRED` / 409 | Original TUS resource horizon expired | Stop refreshing this URL; evaluate backend recovery eligibility. |
| `VIDEO_ASSET_NOT_READY` / 409 | Ready-delete target asset inconsistent/unavailable | Refresh status, disable operation until reconciled. |
| `VIDEO_NOT_AVAILABLE` / 404 | Product missing for reservation | Refresh parent/navigation; stop uploads for missing owner. |
| `VIDEO_UPLOAD_DISABLED` / 503 | New creation flag off or Stream service unavailable | Hide/disable new upload and show availability; existing reconciliation remains separate. |
| `VIDEO_PROVIDER_UNAVAILABLE` / 503 | Provider setup or safe recovery inspection failure | Retain operation identity/state; bounded retry/reconcile. |
| `VIDEO_CLEANUP_PERSISTENCE_FAILED` / 500 | Compensation could not be durably recorded | Stop allocation retries, retain key/IDs, surface support/attention state. |
| `VIDEO_DURATION_EXCEEDED` / status failureCode | Provider-verified duration exceeds 90 seconds | Explain rejected media; choose a compliant new file after old operation reconciles. |
| `BUNNY_TRANSCODE_FAILED` or `VIDEO_PROVIDER_FAILED` / status failureCode | Provider processing failure/status 5 or 6, or a generic placement failure | Show safe processing failure; do not reuse failed generation as ready. |
| `VIDEO_UPLOAD_ABANDONED` / status failureCode | Original upload expired/abandoned | Refetch released slot and begin a genuinely new upload if authorized. |
| 401/403 auth/access | Invalid session/role/control/verified phone | Standard auth/permission flow; never send credentials to provider to bypass it. |

Failure codes can describe previous pending replacement or cleanup while current video stays ready. Display an error alongside its actual operation and keep current media usable according to current status. Do not expose raw provider/database details to end users.

### Product administration acceptance checklist

Verify initial upload of one file and batch of multiple files; explicit feed false; zero-based/gapped positions; parallel admins racing for three slots; duplicate click/lost create response; exact-key replay before and after processing; partial PATCH acknowledgement/resume; mismatched original bytes/length; resource/grant expiry; refresh same resource; valid and rejected nonresumable recovery; recovery 202 then 201 with original placement and offset reset; background/restart retaining file access; cancel racing Ready; failure releasing slot; current-ready replacement upload/processing; pending failure/cancel preserving current media; automatic ready cutover; stale old analytics session invalidation; private active/pending preview and permission failure; feed toggle with and without replacement; explicit delete pending provider acceptance; slot release after acceptance; existing whole Product deletion defeating pending replacement; feature-off behavior; stale responses after account/Product changes.

Source authority: [productVideo.routes.js](D:/Projects/GitHub/petyard/src/domains/videos/productVideos/productVideo.routes.js), `.controller.js`, `.validators.js`, `.service.js`, `.repository.js`, `productVideoReplacement.repository.js`, `productVideoUploadRecovery.repository.js`, `productVideoPreview.service.js`; [bunnyStreamAdapter.js](D:/Projects/GitHub/petyard/src/domains/videos/provider/bunnyStreamAdapter.js); [enums.js](D:/Projects/GitHub/petyard/src/shared/constants/enums.js); [ApiError.js](D:/Projects/GitHub/petyard/src/shared/utils/ApiError.js); [errorMiddleware.js](D:/Projects/GitHub/petyard/src/shared/middlewares/errorMiddleware.js). Backend test evidence is recorded in `VIDEOS_BACKEND_ACCEPTANCE.md`. This checklist is frontend work to perform; backend acceptance does not prove a particular browser/mobile implementation passes it.

## Notification reception and operator follow-up

The YouTube player-error route records a staff review alert; it does not unpublish a video automatically and does not promise immediate push delivery. Eligible recipients are active, non-deleted, non-banned superAdmins and admins with literal enabled control `videos`. Each recipient is deduplicated by editorial Video ID, attempted/current YouTube ID, **UTC calendar day**, and recipient ID. This alert-day rule is distinct from analytics reporting's Africa/Cairo day boundaries. Repeated reports during that UTC day can return `reported:true` while no second notification is created. A deleted/unpublished/relinked owner cannot receive a stale report for its former link.

The alert uses the existing durable notification outbox and dispatcher. Push and in-app storage are asynchronous. An accepted report is backend persistence, not a device delivery receipt. Retries reuse the recipient-specific in-app dedupe key; push delivery is not a general exactly-once guarantee. Android notification receipt was observed in the backend acceptance work; iOS/browser delivery and a new client implementation are not thereby accepted.

### Incoming Videos notification fields

Current YouTube alert does not supply a custom `action.screen` or action params. The existing dispatcher derives FCM data from source:

`{type:"youtube_player_error",screen:"",referenceId:"<editorial-video-id>"}`.

| Field | Type | Meaning / action |
|---|---|---|
| FCM notification `title`, `body` | Strings | Human-readable review alert, currently English push content. In-app title/body localize separately. Do not parse identifiers from text. |
| FCM data `type` | String | `youtube_player_error`, derived from source event because no explicit action type was supplied. |
| FCM data `screen` | String, currently empty | No backend-defined Videos screen name. Do not navigate to an invented screen literally named by an empty string. |
| FCM data `referenceId` | String | Editorial Video ID. Retain for authorized detail lookup if user chooses to review. Not an analytics session, Product ID, or notification ID. |
| Inbox `id` | ObjectId string | Notification ID for mark-read/delete actions. Different from source reference ID. |
| Inbox `title`, `body` | Localized strings | Display content selected with request language. |
| Inbox `icon` | String | `system` for this alert. |
| Inbox `action` | Object or null | Current Videos alert generally has an empty action object. Existing generic notification actions may contain `type`, `screen`, and `params`; do not assume Videos populates them. |
| Inbox `source` | Object or null | Current Videos alert: `domain:"videos"`, `event:"youtube_player_error"`, `referenceId:<Video ID>`. |
| Inbox `isRead` | Boolean | Notification inbox read state; unrelated to editorial review status. |
| Inbox `createdAt` | Timestamp | Inbox creation time, not video publication/report aggregate day. |

Existing authenticated inbox routes are `GET /api/v1/notifications/me?page=1&limit=20&isRead=false`, `GET /api/v1/notifications/me/unread-count`, `PATCH /api/v1/notifications/me/:id/read`, `PATCH /api/v1/notifications/me/read-all`, and `DELETE /api/v1/notifications/me/:id`. They use the application user bearer token. Inbox paging defaults 1/20, caps limit at 50, and supports `isRead=true|false`. List returns direct `{totalPages,page,results,data:[...] }` (no outer data wrapper and no totalResults field). `results` is a row count. Unread returns `{data:{unreadCount}}`; mark-read returns `{data:{message:"Marked as read"}}`; read-all returns `{data:{modifiedCount}}`; delete returns `{data:{message:"Deleted"}}`. Missing/not-owned individual notification is 404. Generic guest inbox routes exist, but Videos staff alerts target user recipients, not reporting guests.

For delivery, the app must already register its real FCM token using the existing `POST /api/v1/notifications/devices/register` flow (JSON `token`, optional `platform:android|ios|web`, optional `lang:en|ar`; authenticated registration allows the existing unverified-phone registration exception). Refresh registration when platform token changes and follow existing account/device ownership conventions. A Video ID is never a device token. Do not create another Videos-specific token table or send a custom notification from the client to repair missing delivery.

Recommended staff flow: show the alert, resolve the current authenticated account/permission, fetch current admin Video detail using `referenceId`, inspect current YouTube link/media, then take ordinary authorized edit/unpublish/review actions. If account changed, permission was revoked, link changed, or video was permanently removed, refresh and show unavailable. A notification is a historical hint; it does not grant permission or guarantee the linked content still exists. A new UI navigation label/path must be agreed in the frontend, because backend currently supplies no Videos screen identifier. This is a client navigation choice, not a missing server endpoint.

Source: [publicVideoError.repository.js](D:/Projects/GitHub/petyard/src/domains/videos/public/publicVideoError.repository.js), `publicVideo.service.js`, [notificationDispatcher.js](D:/Projects/GitHub/petyard/src/domains/notification/notificationDispatcher.js), `notificationOutbox.worker.service.js`, `notification.routes.js`, `notification.controller.js`, `inAppNotification.service.js`, and `notification.validators.js`.

## Final frontend acceptance and release checklist

The detailed customer, analytics, editorial, Product, and provider-operation chapters contain per-flow cases. Use them as test specifications, not as a claim that a frontend has already passed. At minimum, exercise these cross-flow boundaries in the actual admin browser and Android/iOS clients:

| Area | Acceptance required |
|---|---|
| Serialization | Exact data/page envelopes; count vs array; missing vs null; false/0 preserved; correct union field presence; date strings vs Unix seconds. |
| Identity and access | Anonymous reads, valid user/guest, invalid supplied bearer, logout/login, guest/user isolation, role/control revocation, unverified phone, correct account after notification tap. |
| Browse/gallery | All content kinds, Product legacy images preserved, feed opt-in vs gallery, inactive/missing product, localization fallback, empty/disabled lists, pagination mutation/stale response. |
| Playback | Actual device HLS codec/player, YouTube embedding, short URL expiry, refresh and seek preservation, changed generation, unpublish/delete between grant and use, null poster/cover fallback. |
| Upload | Existing-resource TUS HEAD/PATCH, dropped acknowledgement, partial resume, exact file access after restart, no duplicate POST allocation, grant/resource/original deadline, completed bytes vs processing, maximum size/duration, portrait and landscape video. |
| Recovery | 202 without grant, same-key retry, waiting cleanup, same business/session identity, new resource offset zero, original deadline, rejected resumable/completed/uncertain provider state. |
| Editorial | Admin initial review and separate Publish, superAdmin creation distinctions, pending edits preserving current publication, approve/reject/resubmit/cancel, replacement grace, role/status conflicts, signed private preview, automatic HLS verification fence. |
| Covers/order/delete | Multipart actual-byte portrait validation, no manual storage IDs, draft/public positions independent, revision conflicts, all-or-nothing reorder, permanent delete vs unpublish, queued cleanup and cached CDN remnants. |
| Saves/analytics | Serialized save intent and exact retry; no Product save; server-owned save metrics; session identity/current-media binding; exact events, timing/sequence/interval budgets, seek/buffer/background, transactional batch errors, Cairo daily rows and null metrics. |
| Operations/notifications | SuperAdmin-only monitor/retry, queued=false, workers offline/restarting, attention retention, inbox vs FCM IDs, asynchronous notification delivery, current access after historical alert. |

### Evidence already available

The backend checkpoint records **703 passed, 0 failed, 5 opt-in external skips** in the latest normal regression. Separate bounded provider/Mongo/Redis acceptance verified the documented selected upload/resume/recovery, duration, HLS expiry, replacement/cancellation/deletion races, editorial review/private preview/publish/cutover, durable cleanup, and exact orphan adoption paths. The final editorial/cover/orphan run passed four tests including its parent in 159.2 seconds and verified four Stream management objects, two cover origins, and twelve marked collections absent. Completed TUS metadata can remain readable while fresh uploads are denied. Public cover CDN URLs were still cached 200 after origin deletion; immediate eviction was not claimed.

Live and simulated proof are distinguished in [VIDEOS_BACKEND_ACCEPTANCE.md](D:/Projects/GitHub/petyard/VIDEOS_BACKEND_ACCEPTANCE.md). In particular, signed local webhook replay is not actual provider-origin delivery to deployed HTTPS; local worker interruption/restart with simulated provider work is not VPS supervision proof; live orphan adoption covered the selected Reel-initial case, not every five-path permutation. Actual notification receipt on the user's Android phone does not prove all devices. This handoff was verified against current source, validators, controllers, DTOs, and focused test cases; no provider allocations or notification sends are required to verify documentation.

### Work after this handoff

1. Implement the agreed customer and admin screens/HTTP decoders/upload-player adapters/event queues from this contract in their actual frontend repositories.
2. Run the above client acceptance on a deliberately configured integration environment, including actual browser/device player and background/retry behavior.
3. Obtain separate release authorization for commits/push/deployment, securely supply already-existing backend credentials, deploy webhook/worker/indexes, prove provider-origin HTTPS callbacks and deployed supervision, then deliberately open relevant guards/flags in the agreed sequence.
4. Record actual release/device results and remaining issues. Do not mark broad release gates complete from this document alone.

No frontend framework/package, component structure, exact polling interval/chunk size, app screen name, share domain, background-play product policy, or displayed-impression visibility threshold is invented here. Use the existing frontend architecture and confirmed product choices. Backend validation/security/duration/timing limits are mandatory; suggested client retry/lifecycle behavior is identified as guidance. New business/UI decisions must not be smuggled into the API as undocumented fields.

## Documentation authority and maintenance

Use current mounted route/controller/service/validator behavior as authority. Field dictionaries describe current returned shapes, including model-backed administrative optional fields; client writes remain strictly endpoint-specific. If a backend contract changes, update the relevant field dictionary, flow, error/action matrix, persistence map, examples, and client acceptance case together. Historical plans and acceptance checkpoints remain supporting records with their original proof boundaries.

Supporting project documents: [VIDEOS_TODO.md](D:/Projects/GitHub/petyard/VIDEOS_TODO.md), [VIDEOS_SESSION_HANDOFF.md](D:/Projects/GitHub/petyard/VIDEOS_SESSION_HANDOFF.md), [VIDEOS_IMPLEMENTATION_PLAN.md](D:/Projects/GitHub/petyard/VIDEOS_IMPLEMENTATION_PLAN.md), and [VIDEOS_BACKEND_ACCEPTANCE.md](D:/Projects/GitHub/petyard/VIDEOS_BACKEND_ACCEPTANCE.md).
