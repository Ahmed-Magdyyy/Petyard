# PetYard Videos progress checklist

Last reconciled: 2026-10-15, in `D:\Projects\GitHub\petyard`.

## Additive production-handoff extension — 2026-10-15

- [x] Add ordered optional `productIds` (0–50) to existing general YouTube/Reel
  create/edit/admin/public contracts. Preserve omission versus clear, strict
  duplicate/invalid/ineligible rejection, active/proposal separation, automatic
  and reviewed cutovers, legacy empty values and Product Video's singular owner.
- [x] Reuse existing active Product eligibility and `/products/batch`; no copied
  commerce, snapshot endpoint, new route, shared Product/config/notification
  changes or environment/deployment action.
- [x] Verify through existing service/HTTP/worker seams, including hydrated
  Mongoose ObjectIds. Final combined Videos plus two notification regressions:
  **729 passed, 0 failed, 5 external opt-in skips** (734 tests); documentation
  and self-contained Postman checkers pass. Independent review issue resolved.
- [x] Update `VIDEOS_FRONTEND_HANDOFF.md`, four existing collection requests and
  `VIDEOS_PRODUCTION_HANDOFF_RESPONSE.md` with exact contract and proof limits.
- [ ] Release the new extension only after separate authorization; `08ac5b9`
  remains the reported deployed baseline, not this uncommitted extension.
- [ ] Complete actual admin/customer CTA, variants/unavailable Products, physical
  notifications and new controlled upload/playback acceptance on approved builds
  and records. Callback delivery and local fixtures are not full app acceptance.

The earlier checkpoints below retain their original dated scopes. The new
response report distinguishes verified source/local behavior, reported VPS
evidence and not-run provider/device gates; unchecked acceptance boxes in the
incoming handoff were not treated as missing implementations.

Latest live acceptance, 2026-10-10: after the user's `next`, actual Bunny and the
approved Mongo copy passed Reel review/separate Publish, reviewed media/cover
cutover, protected signed HLS preview, preview-gated automatic publication and
exclusive orphan adoption/cleanup despite lost queue acknowledgment. Four tests
including the parent passed, zero failures/skips, 159.2 seconds. Four Stream
videos, both cover origins and twelve marked collections are absent; three
completed TUS records deny new uploads (401/404/404). Both public cover URLs
still served cached CDN 200 after origin deletion; immediate cache eviction is
not claimed. Zero cleanup failures, 102 requests, `.env` unchanged. This scope
is consumed. Normal regression remains 703/0 with 5 external skips, 22.0 seconds.
The selected local backend checkpoint is complete; no known unfinished local
implementation remains. FINAL.04 is complete: the user's detailed customer and
admin scope is documented in `VIDEOS_FRONTEND_HANDOFF.md` (2026-10-10).

Latest replacement-race acceptance: Product cascade deletion versus delayed
replacement Ready and Reel replacement cancellation versus delayed Ready both
passed with actual Bunny and the approved Mongo copy (3 tests including the
parent, 0 failures/skips, 145.5 seconds). Four management videos and twelve owned
collections are absent; completed TUS metadata remains readable but fresh PATCH
returns 401/404. The approved scope is consumed; `.env` is unchanged. Latest
normal regression: **703 passed, 0 failed, 5 external skips**. Broader gates below
retain their proof limits; the later FINAL.04 handoff checkpoint below supersedes
the earlier deferred-document state.

Current work is local-laptop backend implementation and acceptance. No Videos
code has been pushed to the VPS. The webhook/worker and all Stream/YouTube
credentials are present locally; their absence on the VPS is expected and is a
later deployment requirement, not missing local code or credentials.

Session transition: see [VIDEOS_SESSION_HANDOFF.md](VIDEOS_SESSION_HANDOFF.md).
TUS-aware cleanup, V3.10 status-0 abandonment and V3.11 Product non-resumable
recovery are locally complete. Equivalent initial/pending Reel abandonment and
non-resumable recovery are implemented under V5.09.2. The refreshed Videos suite
passes 703 tests, with focused independent source reviews. FINAL.01–03 enum
centralization and verification are locally complete. The user-defined frontend
handoff remains deferred until remaining backend work and acceptance are complete.
Automatic orphan recovery is now wired behind a default-off worker setting.
The authorized MongoDB-copy/local-Redis run passed 24 acceptance checks. A fresh
bounded provider run verified real TUS/HLS/thumbnail/image storage and cleanup;
the actual standalone worker passed isolated startup/restart/shutdown. Combined
The selected provider/database recovery and replacement races and real local
notification delivery passed. Broader provider coupling, deployed webhook,
client and rollout gates remain open. See
[VIDEOS_BACKEND_ACCEPTANCE.md](VIDEOS_BACKEND_ACCEPTANCE.md) for exact proof limits.

This is the current task tracker for YouTube Videos, uploaded Reels, Product
Videos, and their release gates. The [implementation plan](VIDEOS_IMPLEMENTATION_PLAN.md)
retains the detailed chronological evidence. Product policy remains in
[the accepted decisions](VIDEOS_FEATURE_DECISIONS.md); this checklist does not
change scope or reopen those decisions.

## How to read progress

- A checked **Implementation** task means the backend code exists locally,
  not that it has been deployed, enabled, or accepted on devices.
- A checked **Local verification** task means the recorded focused tests
  passed for that slice. Fake adapters do not prove real database/provider behavior.
- **Live acceptance** stays unchecked until its specific evidence is recorded.
- Pending frontend tasks reflect this backend plan. Work in separate admin
  or Flutter repositories has not been inspected and is not claimed complete.
- Latest focused recovery fix: **63 passed, 0 failed** on 2026-10-08.
  Management status 6 now fails unfinished assets without regressing terminal
  assets. Worker/webhook/Product Video/Reel tests use fake external adapters;
  local HTTP access was required after sandbox loopback `EACCES`. This does not
  refresh the earlier full-suite result or close live acceptance gates.
- Previously recorded Videos suite: **617 passed, 0 failed**, in the 2026-10-02
  daily analytics/report checkpoint. Adds nineteen service/HTTP tests for
  transaction-coupled totals, semantic/idempotent retries, native metric totals,
  Cairo/DST midnight splitting, twelve-calendar-month expiry independent of TTL,
  aggregate-failure rollback, report filtering/pagination, real staff middleware,
  unavailable metrics and private DTOs. The nineteen tests also pass with both
  Cairo and UTC process timezones. Real Mongoose update casting is exercised
  against a fake collection; real Mongo indexes, TTL and transaction races are not.
  The preceding save-transition checkpoint added fourteen service/HTTP tests for
  real state changes, no-op/re-save behavior, hidden content, typed identity
  isolation, raw-event privacy, transaction rollback, concurrent requests,
  duplicate-key recovery and exclusion of automatic deletion cleanup.
  The native playback checkpoint added twenty-one tests for
  qualified-view derivation, watch/buffer interval bounds, server-duration
  milestones/completion, short videos, native payloads/retries and protected
  HTTP integration. The ingestion foundation added twenty-one tests
  for atomic rollback, exact retries/conflicts, event ceilings, chronology and
  absolute time bounds, raw-event privacy, visibility/media fences, real HTTP
  authentication and IP limits. The earlier session checkpoint added fourteen tests for typed
  identity isolation, thirty-minute expiry independent of TTL, current media,
  visibility/readiness, safe response/error data, compensating cleanup and IP
  limits. Includes safe reports, real
  user/guest protection, recipient restrictions, UTC-day/generation dedupe,
  rollback and IP limiting, plus transactional
  cleanup/rollback, post-commit dispatch and late-response compensation, fail-closed
  reservation/provider matching and lost-create-response discovery, exact initial/replacement
  provider titles, replay and marker DTO exclusion, real authentication/role checks
  with synthetic database accounts, safe operation DTOs, concurrent immediate
  retry and Redis-loss durability, raw-body signature validation, bounded HTTP
  ingestion, durable exact-replay deduplication and lost-enqueue recovery,
  captured Bunny-response replay,
  explicit-offset preservation, malformed/calendar-rollover rejection, guarded orphan adoption,
  rollback, stale claims, queue/worker retries, atomic removal/cleanup,
  save/deletion and cover-reservation guards, late upload compensation,
  private/public-order isolation,
  draft-edit permissions, batch rollback, stale-revision and
  HTTP authentication/authorization checks, architecture/wiring and middleware
  checks, configured upload-lifetime regressions, five injected Product cache
  regressions, and committed orphan-cleanup queue coverage.
  The 6 shared image-upload tests passed in the preceding cover checkpoint;
  shared image code was unchanged by ordering work.
- Public rollout remains disabled. Reel and cover uploads have additional hard-off
  pipeline guard; changing an environment flag alone cannot make it available.
- Refreshed full Videos regression on 2026-10-08: **634 passed, 0 failed**.
  Cleanup covers rejected/malformed/uncertain TUS termination, management DELETE
  ambiguity, persisted acceptance, callback/database failure and lease expiry.
  Updated three older Product cleanup fakes for termination and GET absence.
  The sandbox attempt failed on loopback HTTP access and those outdated fakes;
  after correcting the fakes, the local-loopback rerun passed all 634 tests.
  Eleven cleanup JavaScript syntax and scoped whitespace checks passed.
- Latest refreshed full Videos regression after deadline abandonment:
  **646 passed, 0 failed** on 2026-10-08. Six added Product and six Reel tests
  cover status-0 deadline handling, preservation of ready/processing/current
  generations and published replacement media, rollback and worker routing.
  The 77 nearest Product/Reel/cleanup tests pass. Independent source reviews
  found no actionable issue in either owner path. All 156 Videos/worker/test
  JavaScript files pass syntax checks and 499 relative imports resolve.
- Latest refreshed full Videos regression after Product non-resumable recovery:
  **667 passed, 0 failed** on 2026-10-08. Twenty-one new service/HTTP/worker
  tests use real internal modules with fake external boundaries. They cover
  strict old-generation cleanup, stable placement/replacement identity and
  deadline, concurrent replay, cancellation, ready-generation races, unknown
  creates, late provider responses, lost commit acknowledgement and stale sweeps.
  Independent source review found no actionable issue. Real-system acceptance
  remains open; no provider, database, Redis, worker or deployment run occurred.
  All 159 Videos/worker/test JavaScript files pass syntax checks, 554 relative
  imports resolve, and 17 scoped whitespace checks pass.
- Latest refreshed full Videos regression after Reel non-resumable recovery:
  **692 passed, 0 failed** on 2026-10-08. Twenty-four new Reel service/HTTP/worker
  and editorial integration tests cover same-session/deadline recovery, old
  published-media preservation, cancellation/proposal removal/permanent deletion,
  late responses, failed setup, concurrent retries, stale claims, lost commit
  acknowledgements, foreign/malformed GUIDs, authoritative provider-state checks,
  safe status data and opt-in orphan adoption. One fake-HTTP adapter regression
  verifies exact Reel and Product recovery markers. Red-before-green tests
  exposed cancellation/deadline/route/GUID gaps, now fixed. Independent source
  review found no remaining actionable issue. Real-system gates remain open.
  All 162 Videos/worker/test JavaScript files pass syntax checks and 578 relative
  imports resolve; 22 scoped whitespace checks pass. No worker or external-system run occurred.
- Latest orphan-worker/acceptance checkpoint on 2026-10-08: **702 local tests
  passed**, 0 failed, with one opt-in external test skipped. **24 real MongoDB/
  Redis acceptance checks passed** (25 including the Node parent), 0 failed,
  with mocked providers. Cleanup confirmed absence of all 18 temporary
  collections and Redis queue keys. Exact coverage and remaining gates are in
  `VIDEOS_BACKEND_ACCEPTANCE.md` and the latest implementation-plan checkpoint.

## At a glance

| Package | Implementation status | What prevents full completion |
| --- | --- | --- |
| V1: configuration/provider adapter | Local foundation and bounded provider/API acceptance complete | VPS configuration and release acceptance |
| V2: durable operations/worker | Local implementation, copied Mongo/Redis and actual process restart verified | Deployed supervision and Bunny-origin HTTPS webhook setup |
| V3: Product Video writes | Local implementation; real recovery and selected deletion/replacement races passed | Extended owner-path provider permutations, client file resend and rollout; orphan sweep remains off |
| V4: product media | Local contract/cache implementation; bounded provider/poster/cover storage proof passed | CDN cache lifetime and device rendering; origin deletion does not instantly evict cached bytes |
| V5: editorial Videos | Local implementation and scoped live review/cover cutover, lifetime, cancellation and Reel orphan proof passed | Extended permutations and release/device acceptance; guards remain off |
| V6: public Videos/saves | Local implementation, real Mongo reads/saves and notification delivery passed | Client/device integration and deployed behavior |
| V7: administration UI | Pending in this plan | Frontend implementation and browser acceptance |
| V8: analytics | Local backend and real Mongo indexes/TTL/concurrency/failure acceptance complete | Staff integration and Flutter telemetry acceptance |
| V9: mobile/canary/release | Bounded backend/provider acceptance recorded | Flutter integration and full end-to-end rollout gates |

Do not turn checkbox counts or passing-test counts into a completion percentage:
one unchecked race-condition or mobile-integration task can outweigh several
checked small tasks. Backend implementation, frontend implementation, and release
acceptance should be estimated separately.

## Architecture alignment — 2026-10-01

- [x] Keep the existing Videos subfolders and align file responsibilities with PetYard:
  route registration, middleware/validators, controllers, services and repositories/models.
- [x] Move HTTP handlers into four controllers and rename the eleven application files
  to services; update source, worker, Product integration and test imports.
- [x] Extract reusable validation without changing accepted inputs or domain error codes.
- [x] Preserve `protect`, role/control checks, super-admin review checks and upload gates;
  use `optionalProtect` on public reads/playback and `protectUserOrGuest` on saves.
- [x] Verify relative imports, production service construction with synthetic configuration,
  authentication boundaries and the full local Videos suite: 425 passed, 0 failed.
- [x] Extract provider-operation, asset-observation and poster queries into repositories;
  keep verification policy, retries, callbacks and provider/storage calls in services.
- [x] Move queue dispatch and Product cache invalidation out of all Videos repositories.
  Repositories return committed cleanup details; services dispatch only after commit.
- [x] Split Product cascade deletion into a service and transactional repository;
  preserve image-only deletion and atomic placement/cleanup persistence.
- [x] Share pagination and Reel readiness rules, and move position validation into validators.
- [x] Honor the configured upload lifetime for Product/Reel creation, replay,
  refresh and replacement; wire the same setting into the worker.
- [x] Verify the five previously bypassed cache-invalidation paths through the Product
  Video service with injected adapters; retain cleanup ordering and Redis-outage tests.
- [x] Run independent read-only source review, 114 JavaScript syntax checks,
  relative-import checks and scoped whitespace checks.
- [ ] Complete the existing real-system acceptance gates below. This refactor does not
  establish MongoDB, Redis, Bunny, frontend or deployment acceptance.

## Final backend cleanup and frontend handoff — agreed 2026-10-02

Perform these tasks after the remaining Videos backend implementation slices,
not as an immediate interruption to feature work. Live acceptance and rollout
remain separate gates; unresolved provider behavior must not be marked complete
by a local refactor.

- [x] FINAL.01 Centralize Videos domain enums in the existing
  `src/shared/constants/enums.js`, following its named `Object.freeze` exports.
  Cover editorial kinds/review states, asset owners/technical states, upload and
  placement lifecycles, provider operation types/states and other repeated
  finite domain values across models, validators, repositories, services,
  controllers and worker integration. Reuse existing roles/control enums.
  Keep materially different lifecycles separate; do not merge them merely
  because they share values such as `pending`, `failed` or `ready`.
- [x] FINAL.02 Replace the corresponding inline domain values without changing
  database values, API strings, defaults, allowed schema/validation subsets,
  transitions, indexes, permissions or module responsibilities. Keep external
  protocol fields, routes, ordinary text and test expectations distinct from
  domain enums; this is not a blanket replacement of every string literal.
- [x] FINAL.03 Verify the enum refactor with a before/after Videos test baseline,
  relevant Product integration checks, syntax/import checks and a final source
  review for missed values, incorrect enum reuse and behavior changes. Record
  actual evidence and remaining real-system gates rather than promising that
  local tests prove every integration is issue-free.
  Evidence: 692/692 Videos and 14/14 selected Product integration tests passed
  before and after the refactor. All 27 new exports are frozen with unchanged
  values/order; 163 JavaScript syntax checks and 640 relative imports passed.
  Captured-source comparison covered all 101 inventoried source files and
  confirmed the 72 changed files contain only the reviewed enum substitutions,
  imports and equivalent typed orphan-filter predicates. Independent source
  review's shared-status finding was fixed and rechecked. See the 2026-10-08
  FINAL.01–03 checkpoint in `VIDEOS_IMPLEMENTATION_PLAN.md` for scope/exclusions.
- [x] FINAL.04 After remaining backend implementation and acceptance are complete,
  prepare a fully detailed Markdown handoff for the frontend developer.
  The user will define its exact contents at that point; do not invent the
  document's scope or claim frontend implementation/testing is complete.
  Latest instruction on 2026-10-08 explicitly defers this document until that work is done.
  The selected local backend checkpoint completed on 2026-10-10. The user then
  explicitly requested an extremely detailed, organized handoff covering both
  customer/mobile and admin flows, every response field, retained identifiers,
  retries and edge cases. `VIDEOS_FRONTEND_HANDOFF.md` now covers all 53 mounted
  frontend-facing routes, Product gallery/notification touchpoints, typed field
  dictionaries, TUS/recovery, review/publication, covers/order/deletion, saves,
  playback/analytics, operation monitoring, error/action tables and client QA.
  Current full-server Cairo timestamp serialization is explicitly documented.
  Verification: 53/53 route inventory, 92 existing local links, 21 parsed JSON
  examples, 105 valid headings/anchors, and zero missing frontend-domain codes.
  The 11-event example passed actual batch validation and ingestion policy:
  17,100 ms watch time and one qualified view. No external requests or code/
  environment changes were made. Release approval and actual frontend/device
  implementation remain separate; broader release gates are not checked here.

## V1 — Configuration and Bunny adapter

### Implementation

- [x] V1.01 Four independent default-off feature flags and fail-closed configuration validation.
- [x] V1.02 Bunny management calls, server-created/persisted TUS resources and scoped upload authorization.
- [x] V1.03 Short-lived, path-tokenized HLS; no unsigned fallback or secrets in public DTOs.
- [x] V1.04 Safe provider errors, request timeout and bounded HLS/thumbnail reads.
- [x] V1.05 Local encrypted Stream/YouTube configuration handoff recorded.

### Local verification

- [x] V1.T Configuration, adapter, status/timeout and authorization tests.
  Evidence: `test/domains/videos/provider/{streamConfig,bunnyStreamAdapter}.test.js`.
- [ ] V1.A Confirm deployed configuration, server-side secret delivery and VPS YouTube access.
  Never copy secret values into this tracker. Live playback/thumbnail proof is under V9.

## V2 — Durable provider work and worker

### Implementation

- [x] V2.01 Typed Video Assets, durable Provider Operations and sanitized Upload Attempts.
- [x] V2.02 Dedicated BullMQ queue/worker; jobs contain only operation IDs.
- [x] V2.03 Mongo dedupe, per-target leases, retry/backoff, needs-attention state and retention indexes.
- [x] V2.04 Lost-enqueue/expired-lease sweeper and stuck-asset management reconciliation.
- [x] V2.05 Accepted/unknown deletion handling and retryable default-poster copy/cleanup.
- [x] V2.06 Validate/deduplicate Bunny webhook hints and durably schedule reconciliation.
  Evidence: 10 webhook service/HTTP tests with real repositories and fake external
  MongoDB/BullMQ; full Videos suite 483/483 and independent read-only review.
  Production webhook configuration and real-system acceptance remain under V9.A7/V2.A.
- [x] V2.07 Expose protected monitoring and super-admin immediate retry for needs-attention operations.
  Global monitoring is also super-admin-only (confirmed 2026-10-02). Evidence:
  9 administration service/HTTP tests; full Videos suite 492/492. Real database/
  Redis/worker and admin frontend acceptance remain separate gates.

### Local verification

- [x] V2.T Provider-operation, runtime, queue, worker-config and model tests.
  Evidence: `test/domains/videos/provider`.
- [x] V2.A Prove real Mongo unique indexes/transactions, Redis loss, standalone worker startup,
  process restart, lease expiry and cross-worker serialization against approved isolated targets.
  - [x] V2.A.1 Authorized copied-Mongo/local-Redis proof on 2026-10-08: actual
    schema indexes, transaction conflicts/rollback, lease contention/expiry,
    stale-token rejection, lost enqueue, isolated Redis-client disconnection,
    redispatch and a fresh BullMQ worker instance. Test resources were removed.
    This does not prove standalone production entry-point startup or a deployed
    process restart, and provider calls were mocked.
  - [x] V2.A.2 Actual standalone entry point on 2026-10-09: starts with isolated
    model collections/Redis prefix, redispatches a persisted failed obligation
    after SIGKILL/restart, and shuts down through its SIGTERM handler with exit 0.
    Provider HTTP is blocked; all temporary resources were removed. This is not
    proof of a crash during a running provider call or deployed supervision.
  - [x] V2.A.3 Expanded actual-process proof: SIGKILL during a held simulated
    provider DELETE, retained BullMQ stalled job, expiration of only the owned
    Mongo lease, restart/reclaim, complete simulated Stream/poster cleanup and
    SIGTERM shutdown. Final run passed in 99.5 seconds; owned Mongo/Redis
    resources absent. No real Bunny requests or deployed supervision claimed.
  - [x] Local PM2 Videos definition explicitly uses the same configured Node
    interpreter as the API; focused configuration assertion/syntax checks pass.
    Read-only VPS checks show the Videos worker/code/Stream and YouTube settings
    are absent there. Existing remote `server.js` modifications must be preserved.

## V3 — Product Video upload/edit/delete

### Implementation

- [x] V3.01 Separate placements; three-slot reservation; immutable upload-selection positions.
- [x] V3.02 Protected batch sessions/status; MP4/MOV and declared 250 MiB validation; verified 90-second limit.
- [x] V3.03 Idempotent sessions, trusted TUS resource persistence and bounded authorization refresh.
- [x] V3.04 Pending upload/replacement cancellation and failed-setup compensation.
- [x] V3.05 Product replacement keeps old ready media until conditional new-asset cutover.
- [x] V3.06 Explicit deletion keeps media until Stream accepts deletion or absence is confirmed.
- [x] V3.07 Whole-product deletion persists provider cleanup before removing local product data.
- [x] V3.08 Feed-visibility control and generation-scoped stale-observation protections.
- [x] V3.09 Unissued-setup recovery and conservative expired-session recovery on authoritative provider absence.
- [x] V3.10 Complete 24-hour abandonment handling for provider objects that still exist;
  do not equate a TUS 404 or early status 0 with safe deletion.
  Bunny support #431686 (reply 2026-10-07) confirms status 0 is not an accepted
  upload and accepts our 24-hour cutoff. Implement it with current-generation
  checks and durable TUS termination/deletion verification. The support reply
  does not supply an exact immediate post-PATCH timeout or deployed-fix proof.
  All prior live allocations are consumed; new provider runs require approval.
  Local evidence on 2026-10-08: matching management status 0 reaches the existing
  original-deadline transaction with persisted status, library, GUID, owner and
  placement/generation fences. Initial slots release; failed replacements keep
  old ready media. Cleanup is durable and uses TUS termination plus GET absence
  verification. Six added tests, 22/22 Product abandonment suite, independent
  source review and refreshed full Videos suite 646/646. Live acceptance is open.
- [x] V3.11 Implement the Q142 non-resumable-resource fallback only with sufficient provider evidence;
  preserve placement/slot/order and durably clean the old generation.
  Support confirms TUS HEAD 404 cannot resume; verify management state before
  replacement. Provider semantics are recorded in `PRODUCT_VIDEO_EXPIRY_RECOVERY.md`.
  Implemented locally for initial and pending replacement uploads through
  explicit protected recovery endpoints. Management status 0 plus fresh-signed
  TUS HEAD 404, or authoritative management absence, may reserve recovery.
  The new generation waits for completed durable cleanup; placement/replacement
  identity, slot, position, visibility and original deadline remain unchanged.
  Existing fail-closed refresh remains unchanged. Twenty-one new tests and full
  suite 667/667 pass, with independent source review. Live acceptance remains
  incomplete; no new live run is authorized.
  - [x] Recognize management failures 5/6 in the shared observer; preserve the
    separate webhook status domain and ready/terminal state fences. Local
    nearest-boundary regression evidence: 63/63 on 2026-10-08.
  - [x] Add durable trusted-resource TUS termination and management absence
    verification before completing provider cleanup. Local cleanup proof:
    107 nearest/634 full tests and independent source review on 2026-10-08.
    Uncertain termination stays due even when management currently reports absence.
    Real Bunny termination/expiry/race acceptance remains pending.
  - [ ] V3.11.A Prove initial and pending replacement recovery against real
    MongoDB/Bunny/Redis, including termination authentication, races, crash
    recovery and client file resend, under separate bounded authorization.
- [x] V3.12 Local guarded recovery for uncertain Product Video creation with no persisted GUID.
  - [x] V3.12.1 Initial and replacement creates use exact, generation-specific
    Bunny titles derived from committed reservation IDs. The same title is used
    for TUS setup; successful replay does not allocate again or expose the marker
    in application responses. No schema changes or provider writes were needed.
  - [x] V3.12.2 Read-only discovery with exact marker, library, creation-time,
    empty-media and already-tracked-GUID checks; ambiguous results fail closed.
    Internal Product Video service diagnostic only, with no HTTP/worker wiring
    or cleanup mutation. Evidence: `productVideoOrphanDiscovery.test.js` (12 tests),
    unchanged Reel recovery interfaces and full Videos suite 506/506.
  - [x] V3.12.3 Transactional cleanup adoption for failed, unissued reservations,
    durable operations and post-commit queue dispatch; preserve current media.
    Evidence: `productVideoOrphanRecovery.test.js` (13 tests), full Videos suite
    519/519. Includes the reviewed late-response/foreign-GUID compensation guard.
    Uses a separate orphan-recovery repository, retained reservation
    records and existing worker operations; no new schema or dependencies.
  - [x] V3.12.4 Bounded automatic worker sweep, shared with Reel recovery, with
    exact-timestamp atomic claims and one global 100-candidate limit. Default-off
    `VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED` controls construction. Nine local
    sweep/repository tests and strict configuration tests passed; real Mongo
    claims passed across all five reservation paths.
  - [ ] V3.12.A Complete remaining real provider/integrated acceptance and approve
    activation. The HTTP service leaves cleanup disabled; no cleanup route was
    added. Local wiring and copied-database tests do not authorize production enablement.
- [x] V3.13 Protected Product Video preview grants while public flags remain off (Q147),
  with explicit active/pending selection, existing product controls and a fresh post-probe check.
  Evidence: `productVideoPreview.{application,repository}.js`, product routes,
  `test/domains/videos/productVideos/productVideoPreview.test.js`; live acceptance remains open.

### Local verification

- [x] V3.T Product application, HTTP, replacement, cancellation, status, trusted-resource,
  setup-recovery, abandonment-race and cascade-delete tests.
  Evidence: `test/domains/videos/productVideos`.
- [ ] V3.A Prove three-slot concurrency, partial batches, replacement/delete/product-delete races
  and cleanup durability with real Mongo/provider state in an approved scope.

## V4 — Product gallery and default posters

### Implementation

- [x] V4.01 Preserve legacy `images`; derive detail-only `media`, images first and videos afterward.
- [x] V4.02 Keep product cards/lists/search image-only; read current eligible media outside the base cache.
- [x] V4.03 Hide inactive/deleted products and detached videos; keep zero-stock products eligible.
- [x] V4.04 Copy default Stream thumbnails through the public Bunny image pipeline into deterministic WebP keys.
- [x] V4.05 Durable poster retries, conditional attachment and strict cleanup; nullable poster while pending.
- [x] V4.06 Finish the Q138 contract/cache review across readiness, replacement, activation,
  feed visibility and deletion. Document when fresh reads replace invalidation; keep identity
  state and signed URLs out of shared caches. Evidence: the transition table in
  `PRODUCT_MEDIA_CONTRACT_PLAN.md`, source review and 81/81 existing focused tests
  across nine files (2026-10-02). No code changes were needed. Base Product DTOs
  remain cached; derived media and Videos/saved/playback reads remain fresh.
  Real Redis invalidation/Mongo aggregation/worker/device acceptance is still open.

### Local verification

- [x] V4.T Product-detail HTTP/media tests and poster tests, including real Sharp processing with fake storage.
  Evidence: `test/domains/videos/public/productMedia.test.js` and
  `test/domains/videos/provider/videoPoster.test.js`.
- [ ] V4.A Validate real signed-thumbnail reads, storage PUT/DELETE, lost acknowledgments,
  suspended/expired workers, CDN deletion behavior and gallery rendering. See V9.
  - [x] V4.A.1 Bounded real provider/storage proof on 2026-10-09: signed thumbnail,
    signed HLS, poster and portrait-cover PUT/authenticated GET/CDN GET; injected
    lost cover response after real PUT; exact origin deletion verified by 404.
    CDN cache eviction, transaction-coupled races and device rendering remain open.

## V5 — Editorial YouTube Videos and uploaded Reels

### Implementation

- [x] V5.01 Canonical YouTube links and Data API eligibility checks at publication/review boundaries.
- [x] V5.02 YouTube create/list/detail/edit, submit/approve/reject/publish/unpublish and pending-change cancellation.
- [x] V5.03 Isolate pending YouTube edits; keep unpublish effective during approval; separate initial approval from Publish.
- [x] V5.04 Single published YouTube position edit/clear with newest-first fallback.
- [x] V5.05 Reel metadata drafts, initial upload reservation/session and typed-owner lifecycle dispatch.
- [x] V5.06 Protected Reel previews and ready-playlist gates; recorded super-admin auto-publication authority.
- [x] V5.07 Known-GUID Reel setup/failure cleanup, preview retry and bounded exact-marker orphan discovery.
- [x] V5.08 Opt-in orphan cleanup application seam; worker wiring now exists
  behind a separate default-off configuration setting. No HTTP cleanup route.
- [x] V5.09 Complete local Reel status/refresh/cancel administration and upload-lifetime handling; full-release acceptance remains V5.09.2.A.
  - [x] V5.09.1 Protected upload status, same-generation authorization refresh and terminal cancellation with durable cleanup. Source: `reels/reelUpload.service.js`, `reelUpload.repository.js`, `reelUploadRecovery.repository.js`, and editorial routes; tests in `test/domains/videos/reels`.
  - [x] V5.09.2 Resolve expired/non-resumable TUS resources locally, with real Mongo/Bunny recovery and expiry evidence. Refresh still fails closed with `VIDEO_UPLOAD_RESOURCE_EXPIRED`; client/full-release acceptance remains V5.09.2.A and rollout stays disabled.
    Existing status-0 initial/replacement abandonment is implemented locally at
    the original deadline, preserving public media and editable proposal metadata.
    Evidence: six added Reel tests, 77 nearest/646 full tests and independent
    source review on 2026-10-08. This evidence remains the abandonment checkpoint.
    - [x] V5.09.2.1 Local initial/pending non-resumable recovery with exact
      provider observations, completed old cleanup before allocation, persisted
      recovery markers, atomic current-asset adoption, stable session IDs/original
      deadlines, safe status data and durable late/uncertain compensation.
      Published media, proposal metadata and review authority are preserved.
      Existing cancellation, whole-proposal removal, permanent deletion and
      setup sweep cover recovery states. Internal orphan adoption stays opt-in.
      Evidence: `reelResourceRecovery.test.js` (24 tests), one adapter marker
      test, full suite 692/692 and final independent source review.
    - [ ] V5.09.2.A Real MongoDB/Bunny/Redis/device full-lifetime acceptance:
      termination authentication, expiry/races, crash/index behavior, file resend,
      review/cutover and unknown unissued TUS POST cleanup. Separate authorization
      is required; no new canary or automatic orphan wiring was performed.
- [x] V5.10 Implement Reel metadata edits and pending reviewed replacement; old public asset remains intact until cutover.
  - [x] V5.10.1 Reel title/description PATCH, isolated admin changes, preview-gated submit/approve, rejection/revision/cancellation and unpublish preservation. Reuses editorial application/model/routes; evidence in `editorialReelDraft.test.js` and `editorialVideoHttp.test.js`.
  - [x] V5.10.2 Reel asset replacement with reviewed isolation, protected pending previews, verified cutover and durable cleanup.
    - [x] V5.10.2.1 Pending replacement reservation/upload, status, exact-session refresh/cancellation, protected pending preview and durable failure cleanup. Active public media stays unchanged. Evidence: `reels/reelUploadBinding.js`, upload/recovery/preview repositories and editorial routes; tests in `test/domains/videos/{reels,editorial}`.
    - [x] V5.10.2.2 Preview-gated replacement review, atomic approval cutover, super-admin automatic cutover and old-asset cleanup. Evidence: `reelLifecycle.{repository,service}.js`, editorial application/repository/routes, worker wiring and `reelReplacement.test.js`. Mongo/provider/device acceptance remains separate.
- [x] V5.11 Implement custom portrait covers for editorial YouTube/Reel content, with reviewed-edit isolation and cleanup. Local implementation only; live acceptance and upload enablement remain under V5.A/V9.
  - [x] V5.11.1 Portrait validation and deterministic Bunny image-storage upload/strict deletion seam. Source: `editorial/editorialCover.store.js` and the shared portrait image profile; evidence: 8 `editorialCoverStore.test.js` tests. HTTP integration is recorded under V5.11.3.
  - [x] V5.11.2 Persist cover generations before storage writes and recover cleanup durably, including lost upload acknowledgements and late responses. Source: cover model/repository/application, image-only Provider Operations and worker sweep; evidence: 21 cover lifecycle tests plus 1 operation test. Unknown upload outcomes remain retryable/needs-attention; monitoring and immediate retry are now local under V2.07, without bypassing authoritative settlement requirements. Real Mongo/Bunny acceptance remains unverified.
  - [x] V5.11.3 Connect cover upload/removal to authorization, pending-change review, atomic replacement approval, cancellation and public cover fallback. Source: editorial cover/Video repositories/application/routes, Reel cutover/recovery and public projection; evidence: 16 new tests, full suite 403/403 and independent source review. Uploads remain hard-off; real persistence/provider/worker acceptance is unverified.
- [x] V5.12 Implement rejected replacement's seven-day grace, resubmission and cancellation cleanup (Q143–Q145, Q160). Source: editorial application/model/repository, Reel upload recovery/binding and worker sweep. Evidence: `reelReplacement.test.js`; real Mongo/provider/worker acceptance remains under V5.A/V9.
- [x] V5.13 Complete backend Reel public ordering and accepted bulk/drag/draft-arrangement APIs; not Product gallery reordering. Frontend implementation and real-system acceptance remain separate gates.
  - [x] V5.13.1 Super-admin set/clear position for one published editorial Reel, preserving YouTube behavior, independent namespaces, newest-first fallback and pending replacements. Fixed the shared schema's rejection of `position: null`. Evidence: `editorialVideoPosition.test.js`, replacement position/cutover tests and public aggregation assertions; full suite 410/410. Real Mongo ordering acceptance remains unchecked.
  - [x] V5.13.2 Atomic bulk public ordering for YouTube/Reel namespaces and the drag-order API contract. Evidence: `editorialVideoBulkPosition.test.js` (10 tests), full Videos suite 435/435 and the bulk positions API contract. Uses one transaction with per-entry revision guards; real Mongo concurrency acceptance remains unchecked.
  - [x] V5.13.3 Admin draft arrangement that cannot change public ordering (Q161). Evidence: `editorialVideoDraftPosition.test.js` (12 tests), full Videos suite 447/447 and the private draft-arrangement API contract. Reuses draft-edit rules; optional field, filtered section lists and revision guards. Real Mongo/frontend acceptance remains unchecked.
- [x] V5.14 Permanent editorial deletion with immediate local removal after durable cleanup commits (Q162), all user/guest saves purged, protected revision/ownership checks and retryable active/pending/detached media cleanup. Evidence: `editorialVideoDeletion.test.js` (14 tests), full Videos suite 461/461 and the permanent-deletion HTTP contract. Save and cover reservation use a private owner write fence; late create/PUT results cannot resurrect the owner. Real Mongo concurrency, worker/provider/storage acceptance remain unchecked; unknown-GUID positive discovery is still V5.15.
- [x] V5.15 Validate positive orphan discovery and guarded cleanup before enabling automatic recovery. Local integrated cleanup and the earlier provider-only positive-match/exact-deletion proof passed. Later local wiring and copied-Mongo/local-Redis proof are recorded below; activation and full live acceptance remain separate gates.
  - [x] V5.15.1 Inspect existing discovery, recovery persistence and provider adapter; rerun their focused tests: 57 passed, 0 failed (2026-10-02). Existing mocked responses do not prove integrated adoption or a live positive match.
  - [x] V5.15.2 Verify integrated adoption/worker cleanup through the user-confirmed discovery/recovery and provider-runtime boundaries, using the real recovery repository and fake external adapters. Evidence: `reelOrphanRecoveryIntegration.test.js`, 8 passed; full Videos suite 469/469. No product-code change was needed. The fake transaction fixture serializes transactions; real MongoDB write conflicts and unique indexes remain unverified.
  - [x] V5.15.3 Positive-match provider acceptance: the separately approved post-fix repeat passed on 2026-10-02. Real inspection returned `candidate` with the exact independently retained test GUID; cleanup DELETE returned 200 and exact-GUID GET returned 404. One empty allocation, no upload/TUS/database/worker work, `.env` unchanged. The prior failed timestamp canary and both consumed scopes are preserved in `BUNNY_REEL_ORPHAN_CANARY_PLAN.md`. Recovery stays disabled/unwired; no further allocation or enablement is approved. Real MongoDB/Redis/worker acceptance remains separate.
    - [x] V5.15.3.1 Correct provider-specific timestamp parsing without changing Egypt response formatting. Four recorded-response/offset/malformed/calendar regression tests added; focused 50/50 passed under Cairo and UTC, full Videos 473/473, independent corrective review clear. No new live provider calls or database writes.
  - [x] V5.15.4 Implement default-off worker invocation for initial and resource
    recovery reservations, including Product equivalents. Real transactional
    Reel orphan adoption and queue recovery passed with mocked Bunny.
- [ ] V5.16 Remove the hard-off Reel pipeline guard only after required completion/acceptance evidence and rollout approval.

### Local verification

- [x] V5.T Tests cover currently implemented editorial and Reel slices, permissions and revision guards.
  Evidence: `test/domains/videos/{editorial,reels}`. This does not cover unchecked features above.
- [ ] V5.A Validate real review/publication, protected previews, replacement/cover isolation, permanent deletion versus concurrent saves/cover reservations and provider cleanup. Cover uploads stay hard-off until persistence, worker and Bunny acceptance plus rollout approval.

## V6 — Public Videos, feed, playback and saves

### Implementation

- [x] V6.01 Published YouTube/Reel detail and YouTube listing with approved localized fields.
- [x] V6.02 Reel/Product/all feed, independently filtered flags and existing page/limit pagination.
- [x] V6.03 Automatic Product Video projection with live product titles and `showInReelsFeed` control.
- [x] V6.04 Rechecked public Reel/Product playback grants, no-store responses and maximum 15-minute HLS lifetime.
- [x] V6.05 Separate user/guest idempotent saves; no merge; Product Video entries are not saveable.
- [x] V6.06 Stable copied covers and no public provider identity, pending-review content or storage descriptors.
- [x] V6.07 Safe player-error reporting/staff alerts for later YouTube unavailability,
  without automatic unpublication after one transient failure (Q154). Evidence:
  `publicVideoPlayerError.test.js`, 9/9; full Videos 528/528; existing notification
  outbox tests 6/6. Uses the existing outbox/worker, owner transaction fence,
  `protectUserOrGuest`, allowlisted reasons and IP rate limiting. No new queue,
  schema, dependency or provider request; public rollout remains off.
  - [x] V6.07.1 Reporting permissions, recipients, UTC-day/current-link dedupe,
    no raw payload/reporter retention and service/HTTP test seams approved by
    the user on 2026-10-02. See the implemented HTTP contract.
  - [ ] V6.07.A Prove real Mongo transaction retry/unique-index behavior and
    deletion/unpublish/link-change races, staff permission changes, outbox
    worker delivery/restart and Flutter error callback mapping. In-memory
    request limits do not establish distributed limiting across API processes.
    - [x] Copied-Mongo report dedupe and report versus delete/unpublish/link
      changes, plus subsequent decisions after staff-control revocation,
      deactivation and banning. Both focused alert checks passed; eighteen owned
      collections were removed and no notifications sent. Full alert/outbox/
      default-dispatcher delivery and Android receipt passed separately.
      Flutter callbacks and deployed process/limiter behavior remain separate.

### Local verification

- [x] V6.T Public application/repository/HTTP, saves isolation and playback visibility/race tests.
  Evidence: `test/domains/videos/public`.
- [ ] V6.A Validate real aggregation/pagination, identity isolation, token expiry and flag rollback.

## V7 — Administration frontend

- [ ] V7.01 Confirm admin repository/owner and finalize the backend-to-admin API handoff.
- [ ] V7.02 Videos tab with separate YouTube and Reel sections; creation/editing/status screens.
- [ ] V7.03 Protected preview, review/reject/publish/unpublish, custom covers, ordering and deletion controls.
- [ ] V7.04 Product create/edit video selection, upload sessions, visibility and replacement/removal controls.
- [ ] V7.05 TUS concurrency/resume/refresh, progress, refresh recovery, safe errors and cancellation.
- [ ] V7.T Browser acceptance for image-only compatibility, partial failure, interrupted upload and review isolation.

## V8 — Analytics

- [x] V8.01 Finalize one server-issued playback-session/event contract for Reel, Product Video and YouTube playback.
  Session contract and service/HTTP test seams approved on 2026-10-02.
  Event limits and all seven metric choices also approved on 2026-10-02.
  Contract completion does not mean ingestion/calculations are implemented.
- [x] V8.02 Bounded batched ingestion, event/session validation, deduplication and rate limits.
- [x] V8.02.1 Identity-protected thirty-minute session issuance and current-media resolution.
  Local service/HTTP path with separate controller, service, validators,
  repository, model and limiter under `videos/analytics`. Fourteen focused
  tests and full Videos suite 542/542 pass. Existing HLS grants stay unchanged.
- [x] V8.02.1.A Real Mongo TTL/index, database-failure and media/publication race acceptance.
  A session is not playback authority or an atomic visibility lock; verify
  event commit fencing separately when ingestion exists.
  - [x] Copied-Mongo indexes and actual playback TTL, service expiry while the
    row still exists, and ingestion versus all three content visibility changes
    passed in the 24-check runner. The focused failure runner also closed the
    actual isolated client: issuance returned safe 503 and added no session.
    This does not interrupt Atlas transport. Provider generation changes and
    client playback remain separate.
- [x] V8.02.2 Atomic bounded event ingestion, exact-payload replay/conflict handling and event limits.
- [x] V8.02.2a Atomic ingestion foundation for impression, share and bounded playback errors.
  Twenty-one service/HTTP tests and full Videos suite 563/563 pass. Real
  repositories and schema validators use fake external Mongo adapters. Native
  playback event types were unavailable in this checkpoint and were subsequently
  implemented for uploaded media in V8.02.2b. YouTube remains capability-gated.
- [x] V8.02.2b Extend the same atomic ingestion path with the accepted native playback metric fields/rules.
  Twenty-one native playback tests and full Videos suite 584/584 pass locally.
  Existing routes, authentication, transaction fences, limits and HLS/session
  responses remain unchanged. No new dependency, queue or configuration.
- [x] V8.02.2.A Real Mongo transaction retries, concurrent visibility/removal, unique indexes and raw TTL acceptance.
  - [x] V8.02.2.A.1 Copied-Mongo proof: concurrent exact retries and shared daily
    upserts, rollback after aggregate failure, typed ownership and expiry,
    actual unique indexes/raw TTL, and concurrent YouTube/Reel/Product visibility
    changes. Hidden content rejects later events without persistence. Provider
    generation/removal races and device telemetry remain separate.
  Evidence comes from actual transactions in isolated copied-Mongo collections,
  rather than fake serialized transactions. Application collections and flags
  were unchanged. Provider generation races and device telemetry remain separate.
- [x] V8.03 Qualified-view/watch rules and honest unavailable YouTube metrics when callbacks cannot be verified.
  Seven-part contract accepted on 2026-10-02 in `VIDEOS_API_CONTRACT_PLAN.md`;
  includes replay session identity, watch intervals, seek/completion conditions,
  per-type fields and save transition counting. Playback calculations and
  committed-save hooks are local; real database/device acceptance stays separate.
- [x] V8.03.1 Qualified views, watch time, milestones/completion, replay and rebuffer processing for uploaded media.
  Semantic counts are internal raw-event markers, not public counters or admin
  reports. YouTube supports only impression/share/bounded errors until verified
  bridge callbacks and duration exist. FE visibility/end-callback claims and
  real Mongo behavior remain acceptance gates.
- [x] V8.03.2 Record customer save additions/removals only on committed state transitions.
  Fourteen new service/HTTP tests; full Videos suite 598/598 passes. Existing
  public save requests record private server events atomically with actual
  changes. No idempotent no-op or automatic editorial deletion cleanup is
  counted. Hidden saves remain removable, identity types stay separate, and
  Product Videos remain unsaveable. Client analytics cannot submit save events.
- [x] V8.03.2.A Real Mongo save/removal/deletion races, transaction retries and shared raw-event indexes/TTL acceptance.
  The copied-Mongo runner passed concurrent duplicate saves/removals with one
  event per transition, user/guest isolation, three concurrent save/delete races,
  actual shared indexes and TTL-monitor cleanup. Only owned temporary collections
  were written; deployed customer collections and rollout were unchanged.
- [x] V8.04 Daily aggregates, retention and admin-only reports; no public counts, viewer-level or location reports.
  User approved transaction-coupled totals, twelve-calendar-month retention,
  existing analytics permissions and one bounded daily report on 2026-10-02.
  New events and actual save transitions update kind/content/Cairo-day totals
  in the same transaction; no new queue or worker. Watch milliseconds split at
  local midnight including DST, while historical totals survive owner deletion.
  `GET /api/v1/videos/analytics/reports/daily` uses `protect`, admin/super-admin
  roles and the existing `ANALYTICS` control. Query defaults to thirty days,
  accepts at most 366 inclusive calendar days and reuses Videos pagination.
  Unsupported YouTube playback and Product Video save metrics are `null`.
  Nineteen new tests; full Videos suite 617/617. No historical backfill or rollout.
- [x] V8.04.A Real Mongo collection/index readiness, aggregate upsert contention,
  transaction retries/uncertain acknowledgement and twelve-month TTL acceptance.
  - [x] Actual cloned collection indexes/TTL monitor, concurrent shared daily
    upserts, exact retries and aggregate-write rollback passed against copied
    Mongo. Local tests cover twelve-calendar-month expiry calculation.
  - [x] After a real successful commit, injected acknowledgment loss caused two
    commit attempts and one transaction callback, without duplicating events,
    session counts or daily totals. Exact caller replay remained a duplicate.
    Both focused copied-Mongo failure checks passed and eight owned collections
    were removed. This injects the caller error; it does not cut Atlas transport.
    Application indexes still require a deployment check.
- [x] V8.T Local replay, invalid-session, timing, rate-limit, retention and report-permission tests.
  Real-system/device proof remains in the separate acceptance tasks above.

## V9 — Flutter, live acceptance and release

### Mobile implementation and device tests

- [ ] V9.01 Confirm Flutter repository/owner and finalize the mobile API handoff.
- [ ] V9.02 One Videos tab with normal-video and reels-style sections; YouTube WebView with safe error handling.
- [ ] V9.03 Native HLS Reel feed for portrait/landscape content; contain/letterbox, no subtitle requirement.
- [ ] V9.04 Product media gallery/posters/tap-to-play and Product links in the feed.
- [ ] V9.05 User/guest saves and `canSave` behavior; analytics integration after V8's contract is fixed.
- [ ] V9.06 Android/iOS background/foreground, navigation, network interruption and expired-token behavior.
- [ ] V9.07 Validate YouTube IFrame callbacks on both platforms; do not infer playback from screen-open events.

### Existing bounded diagnostic evidence — not release acceptance

- [x] V9.D1 Recorded empty-resource and synthetic two-second-media TUS canaries with exact-GUID cleanup.
  Evidence: [TUS canary plan/results](BUNNY_TUS_MEDIA_CANARY_PLAN.md).
  Expiry/status divergence did not establish automatic fallback safety.
- [x] V9.D2 Recorded local read-only YouTube API validation and an empty synthetic Reel-marker search.
  Evidence: the V5 checkpoint in [the implementation plan](VIDEOS_IMPLEMENTATION_PLAN.md).
  These do not prove VPS access, mobile embedding, positive orphan matches or cleanup adoption.

### Live acceptance and rollout

- [x] V9.A1 Agree exact copied/test Mongo target, isolated Redis prefix and permitted provider resources;
  establish cleanup/rollback and explicit authorization before integration writes.
  - [x] Copied MongoDB and local Redis authorized by the user on 2026-10-08.
    Used separate connections, 18 random temporary collections and an unused
    Redis queue prefix. All owned resources were removed and absence checked.
  - [x] User explicitly approved three synthetic Stream videos and three unique
    image objects on 2026-10-09 using configured library/zone credentials.
    The run passed and all owned resources were removed with absence checks.
    This scope is consumed; further allocations require a new bounded scope.
- [x] V9.A2 Real Mongo/Redis worker acceptance, transaction/index proofs, Redis-down/restart and lease-expiry recovery.
  Evidence: V2.A.1–2 and the database/process runners. Redis loss is limited to
  the isolated client; process restart recovered persisted failed work.
  In-flight provider-call crashes and deployed supervision remain separate.
- [x] V9.A3 Portrait/landscape upload, TUS interruption/resume, expiry/fallback, transcoding and duration failure.
  - [x] Bounded landscape canary: partial PATCH/HEAD and fresh-authorization resume,
    strict TUS termination/HEAD absence, ready two-second media and rejected invalid
    bytes. Portrait video and token-expiry proof remain open; recovery fallback
    and real over-limit duration evidence are recorded below.
  - [x] Real Bunny/copied-Mongo Product initial and Reel replacement recovery
    passed, preserving identity/deadline and the real Ready current Reel media.
    The approved cumulative ten-video scope is consumed: all ten management
    videos and twelve temporary collections are absent; seven unfinished TUS
    resources are absent. Three completed TUS metadata records remain readable
    but reject fresh upload signatures after deletion (HTTP 401).
  - [x] Combined Product replacement and Reel initial recovery passed in the
    separately approved five-video follow-up, with real Ready current Product
    preservation, stable IDs/deadlines and old-generation cleanup before allocation.
    Signed local webhook replay/deduplication and reconciliation after injected
    enqueue loss passed. All five management videos and twelve temporary
    collections are absent; four unfinished TUS resources are absent, while one
    completed metadata record remains readable and rejects uploads with HTTP 404.
  - [x] Real over-limit Reel rejection and cleanup: Bunny verified 92 seconds;
    the real application detached the owner, failed the session with
    `VIDEO_DURATION_EXCEEDED`, completed durable deletion and blocked late replay.
    The approved two-video scope is consumed and cleaned up: both management
    GUIDs and twelve owned collections absent; unfinished TUS HEAD 404,
    completed metadata retained with PATCH 404. `.env` unchanged.
  - [x] Portrait media and token expiry.
    The portrait case failed at an expired-grant status assumption. A diagnostic
    on a deleted owned resource found HTTP 400 with explicit expiry text.
    The test now accepts that category, rejects unrelated 400 failures and
    requires live offset/refresh/resume proof. The false two-pass aggregate is
    corrected to one pass/one failure. A separate one-video portrait retry is
    approved and consumed, but failed because Bunny uses expiry-in-the-past
    wording rather than `expired`. Its video/TUS resource and twelve collections
    are absent. The final parser passed a real diagnostic on an already deleted
    resource and the focused test. The approved second one-video retry passed
    portrait transcoding, expired-grant rejection/unchanged offset/same-resource
    service refresh/resume and HLS 200-before/403-after expiry. Its deletion-race
    step failed due to missing application Ready setup; see V9.A5.
    That scope is consumed; its video and twelve collections are absent,
    completed TUS metadata remains readable but PATCH returned 404.
    Final normal regression after all fixture corrections: 703 passed, 0 failed,
    5 opt-in external skips (5.6 seconds). External results are recorded separately.
- [x] V9.A4 Scoped backend proof of initial admin approval/separate Publish,
  super-admin automatic publication and reviewed replacement/cover cutover.
  Actual Bunny/copied-Mongo run on 2026-10-10 passed all three cases plus parent
  (159.2 seconds), including protected actual HLS preview, one denied verifier
  keeping Ready media Draft, exact orphan sweep adoption and durable cleanup.
  All four Stream videos, two cover origins and twelve marked collections are
  absent; CDN retained both public cached covers. This does not prove browser/
  Flutter interactions or every owner-path/provider permutation.
- [ ] V9.A5 Product replacement/removal/product deletion and unknown/rejected cleanup; no unused provider/poster traces.
  - [x] Live Reel initial-creation orphan coupling: an injected lost caller
    response after actual create left no GUID in the failed unissued session;
    exact-marker/library/time/empty-media discovery, two competing actual Mongo
    sweep claims, one adopted asset and one durable operation survived an
    observed lost queue acknowledgment. Runtime cleanup and replay fences passed.
    This uses the consumed four-video/two-cover scope above. Other owner paths
    retain the five-path copied-Mongo claim and existing source/mock evidence.
  - [x] Product whole-owner deletion during replacement and Reel replacement
    cancellation versus held real Ready responses passed with actual Bunny and
    the copied Mongo database. Both Product generations were deleted; published
    current Reel media/session remained intact while pending media was deleted.
    Late replay could not revive deleted media. Three tests including the parent
    passed (145.5 seconds), all four management GUIDs and twelve owned collections
    absent; completed TUS metadata retained with fresh PATCH 401/401/404/404.
    `.env` unchanged, zero cleanup failures; this four-video scope is consumed.
  - [x] Real delayed Ready response versus Product deletion: the fixture now
    applies Ready before holding a second provider GET, and checks durable intent
    while the asset remains Ready until provider acceptance. Forty focused
    local tests passed. The separately approved one-video live run passed:
    actual deletion won, slot released and late replay did not revive the asset.
    Its management GUID and twelve collections are absent; completed TUS metadata
    remains readable but PATCH returned 404. `.env` unchanged; scope consumed.
- [ ] V9.A6 Signed thumbnails/HLS on Android/iOS, token bound, public visibility, mixed pagination and saves isolation.
- [ ] V9.A7 Configure production signed webhooks after endpoint validation; prove missed-webhook reconciliation.
  - [x] Discovered the existing public API from the local admin client's config:
    `api.petyardstores.com`. Both Videos admin GET and unsigned webhook POST
    currently return the application's route-not-found HTTP 400. The local
    implementation is present; deployment/provider configuration are missing.
  - [x] Authorized Firebase transport test to super-admin
    `691abbbbc2b6dc546f3e730f`: nine Android/iOS tokens, 9 accepted/0 failed,
    no registration or database changes. Phone receipt and full Videos
    outbox/dispatcher delivery remain separate evidence.
  - [x] Full local Videos alert service → transactional outbox → delivery worker
    → actual dispatcher/Firebase passed. Two reports deduplicated to one outbox
    obligation and one isolated in-app record; nine pushes accepted, zero failed.
    All five temporary collections were removed. The user confirmed Android
    phone display with a screenshot showing both test notifications.
- [ ] V9.A8 Deploy configuration/worker and frontend/mobile releases with the agreed version gate.
- [ ] V9.A9 Approve staged staff upload enablement, then independent public flags; verify active-session behavior and rollback.
- [ ] V9.A10 Record full acceptance evidence and obtain final release sign-off.

## Recommended next work and estimation boundaries

1. The selected local-laptop backend checkpoint is complete as of 2026-10-10.
   Implementation/enum/source checks, 703 normal tests, real copied-Mongo/local
   Redis and actual worker-process proof, all four real upload-recovery paths,
   real portrait/duration/expiry cases, deletion/replacement races, real local
   notification delivery, and the selected live review/cover/orphan flows are
   recorded in `VIDEOS_BACKEND_ACCEPTANCE.md`. No known unfinished local
   implementation remains in the accepted scope. This is scoped evidence,
   not a guarantee about every permutation or a full release sign-off.
2. FINAL.04 is complete in `VIDEOS_FRONTEND_HANDOFF.md`, using the user's
   explicit customer/mobile plus admin scope. Use its field dictionaries,
   retained-state maps, flow/retry/error instructions and client QA checklist.
   Actual client repository ownership and implementation remain to be established;
   the handoff does not claim frontend/device acceptance.
3. Implement/integrate V7 and Flutter work in the identified client repositories,
   then perform browser/device acceptance. Client file resend, error callbacks,
   actual Android/iOS playback, staff screens and deployed distributed behavior
   remain client/release gates, not missing local backend code.
4. Obtain separate commit/push/deployment and rollout authorization. Configure
   the VPS worker, credentials and HTTPS webhook, verify deployed supervision,
   then approve removal of guards and staged upload/public/orphan flags. Extended
   provider permutations and full release sign-off remain explicitly scoped.
   Previously cached public cover bytes may outlive origin deletion; this live
   run observed CDN 200 for both deleted covers. No immediate eviction is claimed.
   All bounded provider allowances are consumed. Do not allocate again without
   a concrete distinct check and new approval.

For scheduling, estimate these as separate workstreams: **backend feature
completion**, **backend reliability**, **admin frontend**, **analytics**,
**Flutter**, and **integration/release**. There is no verified remaining-day
estimate yet; it depends on client ownership, unresolved provider behavior and
the live acceptance results.

Maintenance: update affected task IDs after each slice; attach the source/test
or canary checkpoint that proves completion. Record dates and scope of tests;
do not silently mark a live gate complete from mock tests or a deployed flag.
Likes/comments and subtitle work remain outside this accepted release scope.
