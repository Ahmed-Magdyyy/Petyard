# PetYard Videos Implementation Plan

Current task status and separate implementation/local-test/live-acceptance
checkboxes are maintained in [VIDEOS_TODO.md](VIDEOS_TODO.md). Use that tracker
for progress; the dated checkpoints below are chronological evidence and older
remaining-work statements may have been superseded.

Scope clarification, 2026-10-09: implementation and current acceptance run on
the local laptop. Videos has not been pushed/deployed to the VPS. Local webhook
and worker wiring plus all five Stream settings and the YouTube API key have
been rechecked as present. VPS deployment/configuration is a later stage,
separate from completing local backend work.

Status: product behavior and V1 start confirmed by the user on 2026-09-22.
V1 and the V2 durable-media foundation are implemented locally behind
default-off switches; planned local V3 and V5 upload-lifetime slices are complete,
the first V5 YouTube editorial and
Reel metadata-draft slices are local,
the V6 public YouTube/Reel/Product Video feed and saves backend slices are local,
the V4 product-detail media projection and planned V8 analytics backend slices
are local. FINAL.01–03 enum cleanup/verification are also locally complete.
The selected local recovery/provider/process acceptance and the user-defined
FINAL.04 handoff are complete as of 2026-10-10. V7 frontend implementation and
broader V9 client/device/deployment/release acceptance remain; the checklist is
the authority for their exact scope.
Product decisions Q1–Q162 are recorded in `VIDEOS_FEATURE_DECISIONS.md`.
`CONTEXT.md`, `PRODUCT_MEDIA_CONTRACT_PLAN.md`,
`VIDEOS_API_CONTRACT_PLAN.md`, and the Bunny documents are companion inputs.

### Two-video media acceptance and portrait retry preparation — 2026-10-09

Final regression after these fixture changes: 703 passed, zero failures, five
opt-in external skips, in 5.6 seconds. External acceptance and cleanup results
remain separate. The frontend handoff remains deferred; broader provider-coupled
replacement-generation acceptance and later client/deployment gates remain open.

Focused database/process follow-up: real analytics commit plus injected lost
acknowledgment passed with two commits, one callback and no duplicate event/
session/daily count. Actual isolated-client disconnect returned safe 503 without
adding a session; eight owned collections removed. Alert versus owner mutation
and changed-staff checks passed; eighteen owned collections removed, no dispatch.
The real worker entry point also passed SIGKILL during a held simulated DELETE,
retained BullMQ stalled-job recovery after owned lease expiry, complete simulated
Stream/poster cleanup, SIGTERM shutdown and verified Mongo/Redis cleanup.
The latest worker run passed in 99.5 seconds. Production code was unchanged;
provider side effects and acknowledgment loss were simulated as documented.

Final media update: the separately approved deletion-only one-video scope passed
against real Bunny and copied Mongo. Durable deletion won against the held real
Ready response; actual provider deletion completed, the slot was released and
late replay did not revive the asset. Its management video and twelve collections
are absent, completed metadata rejects PATCH with 404, and `.env` is unchanged.
The scope is consumed. The dated failed attempts below remain historical evidence.

Newest update: the approved second one-video retry is consumed and cleaned up.
Portrait transcoding, expired grant rejection, unchanged offset, exact-resource
service refresh with unchanged deadline, resumed upload and HLS 200-before/
403-after expiry passed. The deletion race then correctly rejected the fixture's
unfinished placement because Ready had not been applied. The corrected fixture
applies the real Ready snapshot before delaying a second provider GET, and
asserts Ready-with-deletion-intent until provider acceptance. Forty focused
tests passed. A separate one-video deletion-only scope is prepared, requiring
fresh approval; it skips repeating the accepted expiry checks. The real race
and other remaining backend gates are not claimed complete.

Latest update: the first one-video retry was approved, executed and consumed.
It failed because the parser required `expired`; Bunny reports an invalid expiry
time in the past. Its video, unfinished TUS resource and twelve collections are
absent; `.env` unchanged. The parser now recognizes that explicit wording and
passed both the focused test and the actual response diagnostic on a deleted
owned resource, without another allocation. A second separately manifested
one-video retry is prepared, requiring fresh approval. Live portrait/resume/HLS
expiry/deletion-race proof remains open. Normal regression passed 703 tests,
zero failures, four external skips before the final wording correction; the
focused test passed afterward.

The user approved the two-video scope. The real 92-second Reel case passed:
duration-policy failure, owner detachment, durable runtime deletion and late
replay protection. The portrait case stopped because the test required 401/403
for an expired grant. A bounded diagnostic on an already deleted owned resource
returned 400 with explicit expiry text. The acceptance helper now recognizes
that category while rejecting unrelated 400 failures; live offset preservation
and same-resource refresh/resume remain required. Production behavior is unchanged.

Cleanup verified both management GUIDs and twelve owned Mongo collections absent,
unfinished TUS HEAD 404 and completed metadata retained with PATCH 404. `.env`
was unchanged. The scope is consumed. An appended manifest correction records
one passed case and one failed case, replacing the interpretation of the faulty
aggregate count. The runner now counts successful cases before recording success.

A new portrait-only retry is capped at one video and twelve isolated collections.
No-network preflight and the focused expiry-rejection test passed. Fresh approval
is required before allocating it. Portrait transcoding, live grant expiry/resume,
HLS expiry and the real delayed-response/Product deletion race remain open.
The frontend handoff and deployment remain deferred.

### Remaining recovery paths, local webhook and Android notification display — 2026-10-09

The user approved the prepared five-video follow-up and confirmed both test
notifications on their Android phone, with a screenshot. Product replacement
and Reel initial recovery passed against real Bunny and the copied Mongo
database. Together with the prior scope, all four initial/replacement recovery
paths now have successful combined evidence. The current Product media was
actually uploaded and Ready before replacement recovery, then retained.

Signed local webhook HTTP replay passed with real persistence and provider GET:
unsigned request rejected, two identical signed hints acknowledged/deduplicated,
injected enqueue failure retained the obligation, and the runtime sweep
redispatched it before independently verifying Ready. No Bunny webhook setting
or deployed endpoint was changed; this does not prove provider-origin delivery.

Cleanup-only verification passed: all five management videos and twelve owned
collections absent, four unfinished TUS resources absent. One completed TUS
metadata record remains readable but PATCH reports 404. The cleanup test now
accepts explicit 401/403 denial or 404/410 absence, and rejects success, payload
errors and server errors as cleanup proof. The approved five-video scope is
consumed. The separate two-video portrait/expiry/over-limit-duration/deletion-race
runner is prepared and preflighted but not authorized or executed. Its locally
generated portrait and 92-second clips have verified dimensions/duration and
fixed hashes. Backend acceptance remains open; no frontend handoff or deployment.

### Combined recovery and full local notification pipeline — 2026-10-09

The approved ten-video scope was consumed. The initial run exposed a frozen
fixture clock and mismatched Reel creation/TUS titles. Live fixtures now use
advancing time, and Reel TUS metadata preserves the saved reservation marker.
The focused twelve upload tests passed. The remaining five allocations of the
same scope successfully exercised Product initial and Reel replacement recovery
against actual Bunny and copied Mongo: stable identity/deadline, strict old
unfinished-resource cleanup before reallocation, and preservation of real Ready
current replacement media. The two other cases still lack successful combined
evidence. A new five-video follow-up is preflighted, awaiting approval, with a
prepared signed local webhook/durable-hint/reconciliation hook.

Cleanup-only verification passed: all ten management videos and twelve temporary
collections absent, seven unfinished TUS resources absent. Three completed TUS
metadata records remain readable after accepted termination/media deletion, but
fresh upload signatures receive HTTP 401. This is write-denial evidence, not
physical metadata absence. The retained private manifest preserves that limit.

The real Videos player-error service, transaction repository, outbox claim/delivery
worker and default dispatcher also passed a separately authorized account-only
test. Two reports produced one outbox/in-app record; Firebase accepted all nine
registered phones with zero failures, then the obligation became Sent. Five
owned temporary collections were removed; configured customer records and device
registrations were unchanged. The delivered obligation was labelled as a test.
User phone confirmation remains pending. No public flags, provider configuration,
VPS code or frontend handoff changed. Independent review of the initial clock,
marker and cumulative-cap continuation found no actionable issue.
The final normal regression passed 702 tests, zero failures, with four external
checks skipped, in 5.5 seconds. The latest acceptance document corrects the older
completed-TUS absence wording below: a termination acknowledgment alone is not
independent HEAD 404 evidence.

### Bounded provider acceptance and actual worker-process proof — 2026-10-09

The user continued acceptance, authorized reading `.env` and explicitly approved
sending the provider keys to their Google/Bunny APIs for three synthetic videos
and three unique image objects. The successful run verified YouTube eligibility,
partial upload/HEAD/fresh-authorization resume, strict TUS termination/absence,
Ready two-second media, invalid-media status 5, signed HLS/thumbnail bytes, real
poster/portrait-cover WebP storage and origin/CDN reads. A real cover PUT followed
by an injected lost caller response retained deterministic cleanup. All three
videos, TUS resources and image objects were removed with absence checks; `.env`
was unchanged. The scope is consumed. The earlier sandbox DNS/approval failures
created no resources and are not counted as acceptance success.

Added a separate opt-in process acceptance runner launching the actual provider
worker entry point with prefixed models, the approved Mongo copy, local Redis,
explicit test configuration and blocked provider HTTP. It verified unqueued due
work discovery, durable failed work after SIGKILL/restart, and SIGTERM-handler
shutdown with exit 0. Final run passed in 24.0 seconds, 0 failures/0 skips, with
verified collection/queue cleanup. This does not prove in-flight provider-call
interruption, deployed supervision or production dotenv loading. A focused
independent review found no isolation issue; its evidence limits are recorded.

No production source, dependency, feature flag or pipeline guard changed in this
checkpoint. Combined real-provider/database generation/recovery races,
token-expiry/duration-limit proof, staging signed-webhook and test-device delivery,
deployed supervision, client acceptance and rollout remain open. The configured
provider credentials work; staging endpoint and dedicated test recipient/send
permission were requested. Exact proof is in `VIDEOS_BACKEND_ACCEPTANCE.md`.
The frontend handoff remains deferred.

The subsequent notification/endpoint follow-up found the existing public API
in the local admin client's configuration. Videos admin GET and an empty unsigned
Bunny webhook POST both return route-not-found HTTP 400; generic OPTIONS 204
does not prove availability. Deployment and Bunny's endpoint configuration are
therefore missing. The user authorized a push test to all phones under the
supplied super-admin account. A read-only account/device lookup found nine tokens;
Firebase accepted all nine, zero failures. No database/device registrations were
changed. Phone receipt was requested; this proves transport acceptance, not the
complete Videos outbox/dispatcher/device path. Exact details are in the backend
acceptance document.

Read-only VPS checks corroborate the missing deployment: revision `6f0bf36`
lacks the Videos worker/webhook files and Stream/YouTube keys; PM2 has no Videos
worker. The existing server checkout has a modified `server.js`, which must be
preserved. The local Videos PM2 definition now uses the shared Node interpreter;
syntax/configuration assertions pass. No remote configuration/process changed.
The combined Product/Reel initial/replacement real-provider recovery runner is
prepared for a separate ten-video/twelve-temporary-collection scope. Preflight,
independent cleanup review and a real Mongo ownership-marker probe passed.
Its shared recovery fixture rerun passed all 24 copied-Mongo/Redis checks with
verified cleanup in 137.7 seconds. New provider allocation approval is pending;
the prepared runner is not claimed as live acceptance.
The refreshed normal Videos regression passed 702 tests, with zero failures and
three opt-in external checks skipped, in 5.6 seconds.

### Default-off orphan worker and real MongoDB/Redis acceptance — 2026-10-08

The user requested completing remaining backend work and acceptance before the
frontend handoff, and authorized the supplied copied MongoDB database and local
Redis. That approval does not include fresh Bunny allocations, deployment,
environment edits or rollout.

- Implemented a bounded orphan sweep over Product initial/replacement/resource
  recovery and Reel session/resource recovery reservations. Repositories enumerate
  due candidates and atomically claim the expected `updatedAt`; the service shares
  one limit of at most 100 candidates, processes oldest first and isolates candidate
  failures. It reuses existing fail-closed provider inspection and transactional
  cleanup adoption. Probe spacing uses the configured lease interval, preserving
  failure timestamps and original upload deadlines.
- Wired the sweep into the existing provider worker only when the strictly parsed
  `VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED` setting is true. The default is false.
  No HTTP cleanup route, new dependency or environment/flag change was added.
- Added nine local orchestration/repository tests and one configuration test:
  12/12 focused tests passed. Full local Videos regression: 702 passed, 0 failed,
  with the explicitly opt-in external acceptance parent skipped. Selected Product
  regressions: 14/14 passed after the sandbox loopback restriction was removed.
- Added an explicit opt-in integration runner using cloned actual schemas on a
  separate Mongoose connection, 18 unused random temporary collections and a
  separate unused Redis queue prefix. Credentials remain only in the execution
  environment. Providers are mocked; application records, default collections,
  existing queues and the running Redis instance are untouched.
- Final real acceptance run: **24/24 checks passed** (Node reports 25 passed
  including the parent), 0 failed, 0 skipped; duration 131.6 seconds. The checks
  cover actual unique/TTL indexes, slot reservation conflicts, five exclusive
  orphan claim paths, transactional Reel adoption despite lost enqueue, lease
  contention/expiry, Redis-client loss/redispatch and a fresh BullMQ worker,
  editorial review/private changes, mixed pagination, bulk ordering conflicts,
  typed save isolation/transitions and delete races, reviewed cover cutover and
  deletion fencing, staff alert dedupe/outbox persistence, analytics contention
  and rollback, concurrent YouTube/Reel/Product visibility changes versus
  ingestion, Reel replacement, Product replacement versus cascade deletion,
  all four non-resumable upload recovery paths and actual Mongo TTL deletion.
- Cleanup verified absence of all temporary collections and queue keys. Failed
  fixture runs were cleaned up too: missing synthetic Product slugs hit the real
  unique index, and two absent-cover assertions expected null rather than an
  omitted internal field. Fixtures/assertions were corrected without changing
  application behavior or weakening indexes.
- All 168 scoped JavaScript files passed syntax checks, all 693 relative imports
  resolved, and source/document whitespace checks passed. The later analytics
  visibility-race addition also passed its focused syntax and source review.
- Independent source review found fail-fast cleanup and premature collection
  ownership recording in the test runner. Both were corrected; final focused
  reviews found no actionable issue. No reviewer live-system success claim was
  substituted for the actual run.
- Full scope and outstanding gates are in `VIDEOS_BACKEND_ACCEPTANCE.md`.
  Standalone production entry-point/process restart, live Bunny TUS/HLS/storage,
  notification delivery, signed webhook deployment, remaining live races,
  admin/Flutter/device integration and activation/rollout are still open.
  Upload pipeline guards and public/upload/recovery flags remain unchanged.
  No commit, push, deployment or frontend handoff was performed.

### FINAL.01–03 enum centralization and verification — 2026-10-08

- Added 27 named `Object.freeze` Videos exports to the existing shared enums
  file and updated 71 Videos/worker source files. Existing roles, controls and
  unrelated dirty work are preserved. No dependencies or architecture changed.
- Kept separate editorial kind/status, pending-review status, cover state,
  asset owner/technical state, Product placement lifecycle, Product batch and
  replacement statuses, and Reel session status. Product/Reel resource recovery
  share their identical cleanup/reservation/issue lifecycle. Reel purpose and
  Product setup target kind have separate enums.
- Centralized provider-operation type/status, provider execution results,
  upload response status, preview selection, public/analytics content kind,
  user/guest identity type, analytics event/error values and the internal
  qualified-view marker. Asset application results and orphan-recovery results
  have their own enums rather than borrowing persisted lifecycle statuses.
- Full existing value lists use `Object.values`; narrower validator/query lists
  remain explicit enum-member subsets. Ingestion still excludes save-transition
  events, and public YouTube error reporting still accepts only `unavailable`
  and `embedding_disabled`. Defaults, field names, index predicates, transitions,
  permissions, API strings/envelopes and original upload deadlines are unchanged.
- Intentional literal exclusions: provider numeric/HTTP/TUS/YouTube protocol
  values, MIME types/endpoints, routes, DTO field and metric names, ordinary
  text, test expectations and single-use handler/deletion acknowledgements.
  Webhook `ignored`/`recorded` outcomes are distinct from asset-application results.
- Before/after proof: the existing full Videos suite passed 692/692 both times;
  selected Product admin/detail/list, image-update and batch integration tests
  passed 14/14 both times. Tests used `node --test` with
  `--experimental-test-isolation=none --test-reporter=tap` and fake external
  boundaries. The Videos suite passed again after the source-review correction.
- Source proof: captured all 101 Videos/worker/shared-enum source files before
  editing. Reversing the 72 changed files' enum substitutions, computed event
  keys, equivalent full-list folds and imports reproduced the original source
  after line-ending normalization. The three orphan queries retain their exact
  status/failure predicates, with the appropriate batch or replacement enum.
  Unchanged inventoried source also matched its captured baseline.
- Verified all 27 exports are frozen and retain the original values/member
  order. All 163 Videos/worker/shared-enum/test JavaScript files passed syntax
  checks and all 640 relative imports resolved. Focused independent source review
  identified the shared orphan-status filter; it was corrected and rechecked,
  with no remaining actionable finding in that review.
- FINAL.01–03 are checked in `VIDEOS_TODO.md`. FINAL.04 requires the user's
  precise document contents before drafting. Real Mongo/Redis/Bunny/worker,
  signed webhook, provider race/cleanup, administration/Flutter/device acceptance
  and automatic orphan wiring remain separate open gates. No environment/flag,
  live system, worker startup, commit, push or deployment changed in this slice.

## FINAL.04 frontend contract handoff, 2026-10-10

After the selected local backend acceptance completed, the user explicitly
defined an extremely detailed customer/mobile and admin handoff. The resulting
`VIDEOS_FRONTEND_HANDOFF.md` covers all 53 mounted frontend-facing routes and
existing Product gallery/notification integration. It explains every current
response-field family, request validation, identity/permission rules, retained
IDs/files/revisions, TUS/grants/resume/recovery, manual and automatic editorial
flows, pending media/cover cutover, rejection/resubmission, ordering/deletion,
customer playback/saves, analytics/session/event/report rules, provider work,
safe retry and race handling, and frontend QA/release boundaries.

Source review corrected pagination count semantics, admin-only Submit service
authorization, endpoint-specific revision input, same-session recovery, and the
existing full-server Cairo timestamp conversion without timezone markers.
Documentation verification passed all 53 route entries, 92 existing local
links, 21 JSON examples, 105 headings/anchors and all frontend-domain codes.
The documented 11-event timeline passed actual analytics batch validation and
ingestion policy with 17,100 ms watch time and one qualified view. No provider
calls, application edits, `.env` changes, flags/guards, commit/push or deployment
occurred. FINAL.04 is checked; actual client implementation/device acceptance
and separately authorized deployment/enablement remain outside this completion.

## Delivery principle

Build behind four default-off switches. Preserve `/api/v1` product `images` and
the current image-only create path. No public enablement or production uploads
until the Bunny canary and mobile acceptance gates pass. Do not commit, push,
deploy, set secrets, or mutate the live Bunny library as a planning step.

## Module seam and dependencies

### Reel non-resumable upload recovery — 2026-10-08

Completed V5.09.2's local non-resumable recovery slice for initial drafts and
pending replacements. New protected exact-session recovery endpoints keep
authorization refresh unchanged. Matching management status 0 plus fresh-signed
trusted TUS HEAD 404, or authoritative management GET 404, permits a committed
recovery marker and durable old-asset cleanup. A same-key retry waits for cleanup
completion, including TUS termination/absence, management GET 404 and poster
cleanup, before claiming one new resource. DELETE acceptance alone cannot unlock it.

The logical session ID and original abandonment deadline are preserved. New
Video Assets attach before TUS POST and adopt through the existing Reel binding.
Active published media, editorial metadata, position, cover, pending proposal
content and review/automatic-application authority remain unchanged. Cancellation,
whole-proposal removal, permanent owner deletion, changed active generations and
deadline expiry reject late adoption and record known-resource compensation.
Unknown creates retain their marker and block blind allocation. Internal orphan
discovery/adoption accepts the exact recovery ID under the existing default-off
option; production HTTP/worker orphan wiring remains absent.

The existing setup sweep handles stale claims and expired recovery markers;
no new queue or worker is introduced. The worker index list includes the new
recovery model. Safe upload status optionally includes marker ID/status/failure
code, without GUIDs or credentials. Routes retain `protect`, roles and `VIDEOS`
control, plus author/session checks; recovery of existing uploads works with
both new-upload gates closed. Responses are private/no-store.

TDD evidence: 24 new service/HTTP/worker/editorial integration tests cover the
normal flow, cancellation/deletion, pending media preservation, provider-state
guards, deadline retirement/caps, concurrent retries, late GUID/TUS responses,
stale claims, lost commit acknowledgement, rollback, malformed/foreign GUIDs and
safe DTOs. Red-before-green tests exposed and resolved deadline, cancellation,
route and GUID-validation gaps. The shared fake external database now implements
Mongo-style dotted writes, needed for real pending-change persistence.

One fake-HTTP adapter test validates exact Product and Reel recovery markers.
This also fixes the older Product search adapter's omission of its recovery
marker without enabling automatic orphan cleanup. Independent source review
found a missing provider GUID guard; validation now runs before assignment or
attachment, and the regression proves malformed GUIDs retain the unknown-create
marker without scheduling impossible cleanup. Final review found no remaining
actionable issue. Refreshed full Videos suite: 692 passed, 0 failed. All 162
Videos/worker/test JavaScript files pass syntax checks and 578 relative imports resolve.
All 22 scoped whitespace checks pass. The 24 new recovery tests also pass after
the final source readability edit.

No commit, push, dependency, flag, environment, deployment, live provider/database/
Redis mutation or worker startup occurred. V5.09.2.A and V3.11.A real termination,
expiry/race/crash/index/device acceptance, including unknown unissued TUS POST
cleanup, remain open. Automatic orphan wiring remains separately gated. Next
is FINAL.01–03 enum centralization/verification, then the detailed frontend handoff.

### Product non-resumable upload recovery — 2026-10-08

Completed V3.11 locally for initial Product uploads and pending replacements.
Protected `upload-recovery` endpoints accept a file descriptor and stable
idempotency key. The existing authorization endpoints still fail closed and
never allocate media. Recovery requires matching management status 0 plus
fresh-signed trusted TUS HEAD 404, or authoritative management absence.
All other states, identity mismatches and uncertain observations fail closed.

Transactional recovery markers first fence the current asset and record durable
old-generation cleanup. `202 recovering` does not expose upload credentials.
The same-key retry waits for completed cleanup, including TUS termination or
absence, management GET 404 and poster cleanup, before creating one replacement
resource. Placement/replacement IDs, slot, position, visibility and original
24-hour deadline remain unchanged. New grants are capped by that deadline.

The repository pins the old ready generation for pending replacements and
conditionally adopts the new asset. Cancellation, deadline expiry, stale setup
sweeps and changed generations reject late adoption and persist compensating
cleanup. Lost commit acknowledgements cannot delete an issued winner. Unknown
creates retain the exact generation marker and block blind new allocation.
Guarded internal orphan inspection/adoption accepts that marker through the
existing default-off option; V3.12.A wiring remains a separate unauthorized gate.
The existing setup sweep covers stale and expired recovery records. The worker
index list includes the new recovery model; no worker was started.

TDD evidence: 21 new service/HTTP/worker tests, including red-before-green
cancellation and active-generation race tests. Real internal modules use fake
external provider/database/queue boundaries. Refreshed full Videos suite:
667 passed, 0 failed. Focused independent source review found no actionable
issue. API, recovery guidance and tracker updated with the concrete retry flow.
All 159 Videos/worker/test JavaScript files pass syntax checks, 554 relative
imports resolve, and 17 scoped whitespace checks pass.

No commit, push, deployment, provider allocation, real database/Redis mutation,
worker startup, dependency, flag or environment change occurred. V3.11.A real
termination/race/crash/device acceptance remains open. Equivalent Reel recovery
under V5.09.2, final enum centralization and frontend handoffs remain next.

### Existing status-0 deadline abandonment — 2026-10-08

Completed V3.10 locally and added the equivalent initial/replacement Reel
abandonment portion of V5.09.2. A matching management status-0 snapshot may now
retire an awaiting-upload asset at its original persisted 24-hour deadline.
The services reuse the existing deadline retirement transactions, additionally
requiring persisted provider status 0, exact provider GUID and configured library.
No expiry, deadline, upload grant, client response, schema or endpoint changed.

The Product path checks current placement/asset ownership and replacement ID;
initial uploads release the reserved slot and replacements retain old ready media.
The Reel path checks the issued session's original deadline and existing initial
or pending-change binding. It preserves the active published asset and editable
proposal metadata. The worker's existing snapshot handler now routes status-0
Reels to recovery. Processing/ready generations and late callbacks cannot acquire
cleanup ownership. The transaction records detachment, deletion intent, upload
failure and durable provider cleanup together; queue dispatch follows commit.

Product and Reel deadline tracers both failed before their respective changes
and passed afterward. Six Product and six Reel regressions cover early/deadline
observations, replacement/public-media preservation, foreign/stale generations,
ready winning a paused callback, durable-persistence rollback and worker routing.
The Product abandonment suite passes 22/22; the four nearest Product/Reel/cleanup
suites pass 77/77; refreshed full Videos regression passes 646/646. Focused
independent source review found no actionable issue in either owner path. Syntax
checks passed for all 156 Videos/worker/test JavaScript files; 499 relative imports
resolve. Seventeen touched source/test/document whitespace checks also passed.
These are fake-adapter/source results, not real Mongo or provider proof.

V3.11 generation-preserving non-resumable fallback and the corresponding remaining
V5.09.2 upload-lifetime recovery are still pending. Final enum cleanup and the
user-defined frontend handoff remain sequenced after backend implementation.
No live provider/database/Redis writes, worker startup, flags, secrets, dependency
changes, commit, push or deployment were performed.

### TUS-aware durable cleanup completed locally — 2026-10-08

The cleanup adapter terminates only a persisted trusted Bunny TUS URL using a
fresh server-only signature, with strict 204/protocol validation and distinct
TUS-session absence. The worker establishes termination/session absence before
management DELETE. An uncertain TUS result stays retryable; a management GET 404
cannot close that uncertainty. A red-before-green regression exposed and fixed
the earlier combined-catch shortcut. Independent source review confirmed the fix
and the current-generation Product deletion callback's database idempotence.

Product Q93/Q96 still removes local media on management deletion acceptance or
confirmed absence. Cleanup completes only after management GET 404 and poster
cleanup. Persisted acceptance makes restart verification read-only; callback or
database failure and expired leases retain recoverable obligations. `deletedAt`
continues to mean local deletion acceptance, not physical provider absence.

Nearest tests passed 107/107; full Videos regression passed 634/634 with local
loopback access and fake external adapters. The initial sandbox full run exposed
loopback failures and outdated Product cleanup fakes; the fakes were updated to
model TUS termination and post-delete GET absence. Eleven scoped JavaScript syntax
and whitespace checks passed. No provider allocation, real Mongo/Redis mutation,
worker startup, configuration, flag, dependency, commit, push or deploy occurred.
Real Bunny termination authentication, expiry interaction and in-flight races
remain acceptance gates. V3.10/V3.11/V5.09.2 remain separate implementation work.

### Safe session transition — 2026-10-08

At the user's request, the original session paused after the current TUS-aware
cleanup slice's nearest suites passed **102/102**. Adapter termination and worker
ordering have red-before-green proof, but the slice still needs full-suite
verification, focused independent cleanup review and provider acceptance.
`VIDEOS_SESSION_HANDOFF.md` records the exact files, behavior, remaining review
questions, test commands, authorization boundaries and roadmap for session #2.
No live calls, flags, secrets, database/worker changes or deployment occurred.

### Bunny clarification and management failure mapping — 2026-10-08

The user supplied Bunny support ticket #431686's 2026-10-07 reply and approved
the next local implementation step. Its semantics and remaining limitations
are recorded in `PRODUCT_VIDEO_EXPIRY_RECOVERY.md`: late-token expiry can yield
a full-byte 204 without accepted processing; existing status-0 uploads need
our cutoff; TUS 404 is non-resumable; in-flight cleanup requires TUS termination
before video deletion and management GET 404 to establish provider absence.
The proposed provider fix is not claimed deployed, and no arbitrary immediate
post-PATCH timeout or configuration change was introduced.

The first narrow fix recognizes management status 6, alongside 5, as terminal
failure in the shared Video Asset observer. The existing safe failure code,
state/generation fences and Product/Reel cleanup consumers remain unchanged.
Webhook statuses are a separate domain; callbacks still schedule a management
GET instead of applying callback status directly.

At the previously approved worker seam, the status-6 regression failed before
the one-line fix and passed afterward, covering awaiting/processing plus
ready/failed/deleting/deleted preservation. The four nearest worker, webhook,
Product Video application and Reel recovery suites passed **63/63**. The first
run passed 60 and failed three HTTP tests because loopback returned `EACCES`;
the rerun with local HTTP access passed all 63. Independent focused source
review found no actionable issue. The earlier 617-test full-suite result was
not rerun and must not be presented as refreshed evidence.

V3.10/V3.11/V5.09.2 remain incomplete. Next implement durable TUS termination
and provider-deletion verification, then existing-object abandonment and
generation-preserving fallback. Live Bunny/Mongo/Redis/device acceptance,
configuration, flags, deployment and final enum/FE handoff remain untouched.

### Post-V8 recovery gate reconciliation — 2026-10-02

Reviewed V3.10/V3.11, V5.09.2 and V3.12.A against the current recovery/refresh
source, worker wiring and saved empty/completed/late-processing canary evidence.
The accepted full-byte 204 followed by TUS 404 and management status 0 remains
unresolved; the two incomplete 408 follow-ups cannot establish its terminal
outcome or a universal safe abandonment deadline. No further provider
allocation is authorized. Existing conservative matrix, exact-generation
refresh, original deadlines and explicit-cancellation behavior remain unchanged.

Only management GET 404 enters missing awaiting-upload recovery; identity,
current generation and transaction checks preserve processing/ready media.
Unknown-GUID Product Video discovery/adoption remains an internal opt-in:
production leaves `allowOrphanCleanup` false and no worker invocation exists.
Focused unchanged recovery suites passed 56/56. This is local regression proof,
not real Mongo/Bunny acceptance; the previous 617-test Videos baseline is
retained rather than rerun for documentation-only work.

Added an unsent, copy-ready Bunny clarification draft to the existing
`PRODUCT_VIDEO_EXPIRY_RECOVERY.md`. It asks for an authoritative complete-source
signal, a terminal status-0 condition, trustworthy non-resumability semantics
and deletion confirmation during in-flight processing. Provider-dependent
tasks and final enum/FE sequencing remain pending. No product code, live call,
secret/configuration, dependency, queue/worker, flag, commit, push or deploy
changed. Next work needs the missing provider evidence or an explicitly chosen
separate acceptance scope; it must not invent a destructive recovery policy.

### V8.04 daily analytics and staff reports checkpoint — 2026-10-02

The user approved four daily-total/report rules and reuse of the existing
analytics service/HTTP test seams. Added one strict daily-total model, a pure
Cairo bucket/metric policy and shared analytics persistence repository. Existing
ingestion and actual save-transition transactions now record raw events and
their daily increments together; session/save changes roll back if either
storage step fails. Only newly committed, counted events contribute, so exact
retries and semantic no-ops do not double count. Existing content-owner fences
and duplicate-key save recovery remain in place. No background queue or worker
was added; installed Luxon handles the accepted civil-time policy.

Totals group by kind, stable content ID and Cairo calendar date. Watch chunks
split at each actual local midnight, including skipped and repeated DST hours.
Qualified-view increments belong to the crossing chunk's end day; other action
counts and rebuffer durations use their event end day. Expiry is the bucket's
next local start-of-day plus twelve calendar months, normalized to local
start-of-day, with calendar month-end clamping. Expiry never moves on later
increments. A unique kind/content/day index, report-sort index and absolute TTL
index are declared; reports explicitly exclude expired rows even if TTL has
not run. No owner join or deletion cascade erases historical totals.

The existing analytics router exposes
`GET /api/v1/videos/analytics/reports/daily`, with real `protect`, staff roles
and the existing `ANALYTICS` control. The service repeats the authorization
boundary for non-HTTP callers. Validators allow only kind/content/date/page/
limit filters, default to the last thirty Cairo calendar dates and bound an
inclusive range to 366 dates. Controllers return the existing Videos pagination
envelope with private/no-store. DTOs contain only day/kind/content ID and the
allowlisted metrics. YouTube native playback metrics and unsaveable Product
Video save metrics are `null`, never fabricated zeroes. Public flags do not hide
historical staff reports. There are no public counts or viewer/location reports.

TDD tracers failed for the missing report interface, missing native metrics,
unsplit watch intervals, unavailable-metric zeroes, ignored filters, missing
save aggregation and missing protected HTTP route, then passed with their
corresponding minimal implementation. Nineteen new service/HTTP tests cover
counts, DST/midnight, calendar expiry, filtered/paginated reports, aggregate
failure rollback, identity-protected staff access, concurrency/retry behavior
and private DTOs. Real Mongoose upsert casting is also exercised against a fake
collection. Existing real editorial-service deletion tests now verify retained
history without customer removal counts. Full Videos suite: 617/617, zero
failures. The nineteen daily tests pass under both Cairo and UTC process
timezones. Independent read-only review found no confirmed blocker.
Thirteen JavaScript syntax checks and seventeen scoped whitespace checks passed.

This is prospective local aggregation, not a backfill of earlier raw records.
Real Mongo collection creation, unique/TTL index readiness, write conflicts,
transaction retries and retention execution remain V8.04.A. No live database,
provider, Redis or notification call, environment/package change, rollout,
queue/worker startup, commit, push or deploy occurred. Next: read-only
reconciliation of remaining upload-recovery/provider-evidence gaps before the
next bounded backend slice. Final enums and the user-defined FE handoff remain
after backend reliability completion.

### V8.03.2 committed save-transition analytics checkpoint — 2026-10-02

Added server-only `save_added` and `save_removed` records to the existing raw
analytics event collection. The public Videos service creates the private
server UUID, content reference, timestamps, counted marker and thirty-day
expiry draft. Its repository supplies the authoritative editorial kind and
persists that draft only when a save is actually inserted or removed. No
playback session, client event/hash, viewer identity, IP, location, provider
descriptor, new public count or client analytics type is introduced.

Addition reuses the existing owner-fenced transaction and duplicate-key retry.
Removal now fences the editorial owner and deletes the typed identity's save
in one transaction, inserting an event only when `deletedCount` is nonzero.
Both the saved-state mutation and event insertion commit together. Analytics
persistence failure aborts the state change and returns a safe
`503 VIDEO_SAVE_UNAVAILABLE`; uncertain database acknowledgements remain a real
acceptance concern, with state-based retries preventing duplicate transitions.
The internal repository event argument remains optional for existing callers;
the production public save service always supplies it.

Removal allows any existing editorial status so hidden saves stay removable;
new saves still require public eligibility. Permanent deletion continues to
remove saves directly in its existing transaction, with no customer-event
hook. Both paths write the owner, serializing actual customer removal against
automatic cleanup. Existing user/guest separation and unsaveable Product
Videos are unchanged. Requests and successful `{videoId,isSaved}` responses
are unchanged; save mutation responses now explicitly set private/no-store.

The shared event schema conditionally requires playback session/hash only for
client playback events and rejects Product Video save transitions. Existing
client event validation still rejects all save types. The unique session/event
index also covers server events through their random event IDs, without a
session binding. Source event fields stay immutable, and expiry is requested
thirty days after server receipt. Daily aggregation and reports are not added.

TDD: the first real public-save service tracer failed because no server events
were written, then passed. The real HTTP tracer exposed missing no-store
headers and passed after adding them. Fourteen tests cover actual transitions,
no-op/re-save behavior, both saveable kinds, typed identities, hidden saves,
private server event shape/time, rollback on event failure, fake concurrent
requests, duplicate-key recovery, real editorial-service deletion cleanup,
rejected client save telemetry and real authentication on unchanged save routes.
The previously approved public reads/saves service/HTTP seams are reused with
real own collaborators/schema validation and fake external database adapters.
Focused save/public/deletion suite: 46/46; full Videos suite: 598/598, zero failures.
Five JavaScript syntax checks and nine scoped whitespace checks passed.
An independent read-only review found no confirmed blocker.

This is local implementation proof only. Real Mongo write conflicts, retries,
unique/TTL indexes and device/server deployment remain acceptance gates. No
provider, Redis or notification call, live database write, environment/package
change, queue/worker startup, rollout, commit, push or deploy occurred. Next:
V8.04 daily aggregates, Cairo-day splitting, retention and admin reports.
Final enum consolidation and the user-defined FE handoff stay later.

### V8.02.2b / V8.03.1 native playback metric checkpoint — 2026-10-02

Extended the existing ingestion validators, business processor and private
session/raw-event models. No new HTTP route, repository, framework, package,
configuration or queue was needed. Routes/controllers/authentication and the
existing transactional session/media fences remain unchanged. Reels and Product
Videos now admit all accepted playback event types; YouTube retains only basic
impression/share/bounded-error telemetry until callbacks and duration are verified.

Starts, replay, impressions, individual milestones and completion are semantic
once-per-session counts, regardless of new event IDs. Exact normalized retries
remain duplicates before applying new-event metric conditions. `watch_time`
uses integer 1–10,000 millisecond intervals ending at `occurredAt`. Admission
rejects overlapping watch/buffer intervals, intervals before the issuance
clock-tolerance floor or a reported actual start, and totals above elapsed
server time. New intervals update session state inside the existing transaction.
The chunk first crossing 2,000 admitted milliseconds carries an internal
`qualifiedViewCounted:true`; no client qualified-view input or phantom raw
event is accepted. Missing start telemetry does not automatically discard valid
watch chunks; once a start is reported, watch intervals cannot predate it.

Progress and completion use only captured/current server-verified duration.
Milestones require both position and admitted watch at their fraction;
completion requires at least 95% admitted watch and position in the final
second. A later callback does not invent earlier milestones. Short videos may
complete without a qualified view. The callback type is client telemetry;
the server cannot independently prove an actual end, foreground visibility,
human attention or coverage of unique footage.

Rebuffer episodes require a previously reported actual start, integer duration
1–300,000 milliseconds fitting elapsed session time, and no overlap with
previous watch/buffer intervals. Initial loading, repeated overlapping episode
callbacks, buffering milliseconds as watch, and buffer-derived views/progress
are rejected. FE must reuse an event ID for retries and create a fresh session
for an actual loop/restart. No viewer-linked history was introduced.

TDD tracers failed before adding starts/replay, watch/qualified view,
milestones/completion and rebuffer processing, then passed one slice at a time.
A final regression exposed admission of watch time before a reported actual
start; its test passed after adding that interval guard. Twenty-one new tests
exercise the real analytics service and protected HTTP route with real own
collaborators/schema validation, a fake external database and controlled time.
The previous unavailable-metric test now asserts the still-required YouTube gate
using well-formed per-type payloads. Full Videos suite: 584/584, zero failures.
Fifteen JavaScript syntax checks and nineteen scoped whitespace checks passed.
Independent read-only review found no confirmed metric/validation/privacy or
transaction integration blocker; real database and device limitations remain.

Only local code/schema/fake-adapter proof is claimed. Real Mongo transaction/
index/TTL behavior, deployment and FE/device event accuracy remain unverified.
No environment changes, external calls/writes, worker startup, rollout,
package installation, commit, push or deploy occurred. Next: V8.03.2 committed
save-transition hooks, followed by V8.04 aggregate/report work. Final shared
enum consolidation and the user-defined FE document remain later.

### V8.02.2a analytics ingestion foundation checkpoint — 2026-10-02

Implemented `POST /api/v1/videos/analytics/events` for the narrow basic-event
slice: impressions, shares and bounded playback errors for YouTube, Reels and
Product Videos. Existing HLS/session response contracts remain unchanged. The
route composes the installed IP limiter and real `protectUserOrGuest`; the
controller owns HTTP/identity extraction, validators own request normalization,
services own metric processing, and the repository owns transactional storage.

Batches accept 1–50 events and at most 64 KiB of logical UTF-8 JSON, in addition
to the existing global parser bound. Unknown fields, ambiguous/calendar-invalid
timestamps, arbitrary metadata and unbounded error messages fail closed. UUID
casing and explicit timestamp offsets normalize before hashing. Exact
session/event payload retries succeed without inserting twice; changed payloads
conflict. New events obey the accepted age, future, issuance and chronological
bounds. Exact retries may be older than the five-minute new-event window, but
still require a valid, owned session and eligible current media. The session
ceiling is 500 distinct events; duplicates do not consume it. Ingestion has its
own 60-attempt/minute/IP/process limit, including rejected authentication.

A single Mongo transaction covers every session group, raw event insert and
session counter/semantic state update. The private session revision serializes
same-session submissions. Transactional writes fence editorial ownership,
Product Video placement/parent, asset and Reel upload generation against
visibility, replacement and deletion changes; eligibility reads use that same
transaction. Product gallery-only playback remains eligible, and a pending
Product Video deletion does not hide media before provider acceptance. Runtime
flags and session expiry are rechecked before the transaction callback ends;
process-local flags are not a transactionally stored visibility protocol.

Raw events contain content/session/event references, normalized timestamps,
bounded error reason, payload hash and internal counted state, never viewer
identity, IP, location, provider URL or credentials. Their schema requests a
unique session/event index and expiry 30 days after receipt. Impression is
semantically counted once per session; the server requires one elapsed second
but cannot independently prove foreground visibility. Shares/errors may repeat
with distinct IDs. No aggregate counter/report is exposed. Known native
playback events explicitly return `VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE` until
the accepted watch/progress/replay/rebuffer rules are implemented.

TDD: the service tracer failed on the missing ingestion method, then passed;
the HTTP tracer failed with route 404 instead of protected 401, then passed.
The existing analytics external-database fixture was shared only after the
fourteen session tests passed before and after extraction. Twenty-one new
service/HTTP tests cover rollback, cross-session and same-batch conflicts,
normalized retries, limits/timestamps, privacy, availability, safe database
failure, failed fences, flags/expiry during storage, and actual authentication
and IP limiting. Fake transactions serialize locally; they do not prove real
Mongo transaction retries, write conflicts, unique-index execution or TTL.

Verification: full Videos suite 563/563, zero failures; fourteen JavaScript
syntax checks and eighteen scoped whitespace checks passed. Independent
read-only auth/privacy/transaction review found no actionable blocker and
retained the real Mongo topology/retry/index/TTL acceptance limitations.
Live database/provider/
Redis/notification calls, environment/package changes, rollout, commit, push
and deploy remain outside this slice. Real Mongo acceptance is V8.02.2.A.
Next: V8.02.2b/V8.03 native playback processing through the same boundaries.
Save transitions, daily aggregates/retention/report access remain pending.
Final enum consolidation and the user-defined FE document remain later.

### V8.02.1 analytics session checkpoint — 2026-10-02

The user approved all seven V8.03 metric choices; session/event contracts and
service/HTTP test seams are now accepted. Implemented only the narrow session
slice under `src/domains/videos/analytics`: route/controller/service, separate
validators, repository, private session model and installed-dependency limiter.
`src/app/routes.js` mounts the new analytics router before general Videos.
Existing dirty imports/routes were preserved; only the analytics import/mount
were added. No existing HLS grant interface changed.

The POST accepts kind/content ID and uses real `protectUserOrGuest`. It returns
only an opaque UUID v4 and explicit-offset expiry, private/no-store, for current
eligible YouTube/Reel/Product Video content. Existing public repositories and
the shared Reel readiness policy own media eligibility. Independent public
flags remain default-off; product feed opt-in is not a gallery playback rule.
Pending Product Video deletion still uses provider acceptance/confirmed absence.

Session persistence captures typed identity, exact media generation, uploaded
duration and fixed 30-minute absolute expiry. Internal service resolution checks
ownership, dates, flags and fresh media. TTL cleanup is not expiry authority;
malformed dates fail closed. Issuance rechecks media after persistence and
compensates an unsuccessful issuance with eager removal. A failed/uncertain
write acknowledgement or failed cleanup may leave an unreturned row for TTL.
This is ephemeral analytics state, not a playback grant, owner lock, raw event
or report. Event writes must recheck at their persistence boundary. No provider
GUID, URL, credential or identity is exposed in the HTTP response.

TDD: service tracer failed on missing implementation, then passed; the HTTP
tracer failed with 404 instead of protected 401, then passed after wiring.
A malformed-expiry test exposed acceptance of NaN dates and passed after the
explicit validity/lifetime check. Added real schema/authentication/JSON-replacer
checks and fake external database coverage for all three content kinds, typed
identity separation, stale media/flags, readiness/ownership, product deletion,
safe failures, compensation and 120-attempt IP limiting. The existing static
architecture route-count assertion was updated from six to seven; no layer or
import protection was removed. Initial isolated Node test spawning hit EPERM;
the existing no-isolation test mode ran normally and established the actual reds.

Verification: 14 focused tests; full Videos suite 542/542, 0 failed; ten
JavaScript syntax checks and fourteen scoped whitespace checks passed. Independent
security/privacy review found no blocker. Its TTL-only wording concern was
clarified in the API contract: routine expiry uses TTL, while unused unsuccessful
issuance may be removed eagerly. Real Mongo TTL/index execution, route-stack
deployment and concurrent visibility changes remain unproven. No live
database/provider/Redis/notification calls, package or environment changes,
worker startup, rollout enablement, commit, push or deploy occurred.

Next: V8.02.2 bounded atomic event ingestion and its first metric slice. Watch,
replay/progress/completion calculations, save transition recording, aggregates
and reports are not implemented. V8.04 report/processing decisions remain
separate; final enum cleanup and the user-defined frontend document stay later.

### V8.01 event-limit approval and V8.03 metric review — 2026-10-02

The user approved all five event-ingestion choices and their numeric limits.
Recorded that acceptance separately from the earlier pending checkpoint.
Inspected accepted Qualified View terminology, current verified Video Asset
duration, the YouTube verifier/editorial schema, and existing request limiters.
Uploaded duration is persisted, but YouTube duration is neither requested nor
persisted by current editorial verification. Do not infer server-verified
YouTube duration from a client player callback.

Recorded seven pending V8.03 metric choices in the API contract: one session
per playback attempt/replay without a separate cycle framework, semantic
once-per-session metrics, foreground visible non-overlapping watch intervals,
duration-backed progress and 95%-watched completion, bounded share/error/
rebuffer data, granular YouTube capability/duration gates, and committed save
transition counting. These choices require approval before implementation.
Session issuance/telemetry failure would not block media playback. Existing
IP ceilings and the 30-minute analytics/15-minute HLS lifetime distinction stay
intact. Chronological submission and midnight watch-time splitting are explicit.

Only four planning documents changed; no code, environment, package, runtime,
provider/database, worker, commit, push or deployment changes occurred. No test
suite was rerun for document edits. The prior 528 Videos test result is not
new implementation proof. Next: approve metric semantics, then implement the
small session/ingestion slices at the already accepted service/HTTP test seams.
V8.04 aggregate/report decisions remain separate; enum cleanup and the final
user-defined frontend handoff remain later tasks.

### V8.01 session approval and event-limit checkpoint — 2026-10-02

The user approved the six-part session contract and service/HTTP test seams.
Updated the accepted decisions and API contract without changing the earlier
accepted MVP metrics, retention or privacy rules. Recorded a separate pending
event-ingestion proposal: 1–50 events per batch, 64 KiB logical JSON bound,
allowlisted types, five-minute age/30-second future tolerance, atomic batch
acceptance, exact-retry deduplication/changed-payload conflicts, 500 distinct
events per session, and existing-dependency IP limits. Qualified views would
be derived from watch time; save metrics would use committed save mutations.
Per-type fields/counting rules remain the next V8.03 review, not silently
invented implementation. Existing global parsing and limiter scope are
explicitly distinguished from proposed per-route limits.

Only planning documents changed. No code, environment, runtime, external
system, package or Git release changes occurred. No new test run was needed
for this documentation-only step; 528 passing Videos tests remain prior
evidence. Enum cleanup and the user-defined frontend document remain later.

### V8.01 session contract review checkpoint — 2026-10-02

Inspected current public Reel/Product Video grants, their optional protection,
public Videos identity handling, accepted analytics decisions Q26/Q126/Q127/
Q139/Q140/Q150, the existing staff analytics permission pattern, and the Egypt
JSON timezone presentation helper. No analytics session/ingestion code exists
yet. Recorded a pending six-part proposal in `VIDEOS_API_CONTRACT_PLAN.md`:
one session POST for all content kinds without modifying existing HLS GETs;
identity-bound 30-minute sessions; current-media eligibility checks; private
session ownership and session/event deduplication; absolute expiry with Cairo
daily buckets; and service/HTTP test seams using fake external adapters.

This is a documentation-only review, not user acceptance or implementation.
No code, environment, provider, database, worker or release changes occurred.
The last recorded 528-test result remains prior evidence, not a new test run.
Next: obtain session proposal/test-seam approval, then settle bounded event
values and metric rules before implementation. Enum cleanup and the detailed
user-defined frontend handoff remain later tasks.

### V6.07 implementation checkpoint — 2026-10-02

- The user approved the reporting policy and Public Videos service/HTTP test
  seams. Implemented `POST /api/v1/videos/:id/player-errors` through the existing
  route/controller/service, with separate public validators, limiter and
  persistence helper. Routes register middleware/handlers only.
- Reused `protectUserOrGuest`, role/control enums, installed `express-rate-limit`
  and the existing durable notification outbox. Reports require published
  YouTube identity plus the exact YouTube ID being played, accept only
  `unavailable`/`embedding_disabled`, and never auto-unpublish or call YouTube.
  `VIDEOS_PUBLIC_ENABLED=false` still rejects the endpoint.
- The transaction writes the existing owner association fence (not editorial
  revision/timestamps), selects active eligible non-deleted/non-banned staff,
  and records recipient alerts atomically. Existing outbox dedupe is per
  Video/YouTube ID/recipient/UTC calendar day; identities/reasons cannot flood
  recipients with duplicate alerts. Failure rolls back all recipients and
  returns a safe retryable error. No new schema, queue or dependency.
- Safe static notification text labels the error as unverified, with only the
  allowlisted reason and content reference. No reporter identity/raw error/URL
  is added to alert data. Existing application authentication/error logs remain
  unchanged. A 202 private/no-store acknowledgement exposes no delivery count.
- IP limit: 10 attempts per 15 minutes per API process; rotating guest IDs does
  not evade it. The existing in-memory pattern is not a distributed limit.
  Real cross-process limiting is not claimed. The contract records callback
  mapping against the official YouTube IFrame API and distinguishes error 153
  (client identification/referrer) from later content unavailability.
- TDD: the first service test failed because reporting did not exist, then
  passed after implementation; the first HTTP test failed with route 404, then
  passed after middleware/controller wiring. Added recipient exclusion,
  repeated/concurrent identities, UTC rollover/link change, hidden/wrong-type
  content, invalid payloads, rollback/retry, no-recipient privacy, stale-link
  fence and IP-limit checks. Nine new tests pass using the real internal
  modules/outbox enqueue code and fake external database/notification commands.
- Verification: full Videos suite 528/528; existing notification outbox suite
  6/6; eight JavaScript syntax checks and twelve scoped whitespace checks passed.
  Independent read-only security/concurrency review found no blocker in the
  new flow. The fake database serializes transactions and does not prove real Mongo
  retry/unique-index behavior. Actual notification worker/FCM/device acceptance
  remains V6.07.A; no live messages, provider/database calls, worker startup,
  environment changes, rollout enablement, commit, push or deploy occurred.
  The final enum cleanup and user-defined detailed frontend document remain
  later tasks. Next narrow slice: V8.01 analytics playback-session contract.

### V6.07 inspection checkpoint — 2026-10-02

Q154 confirms safe YouTube player errors and staff alerts, without automatic
unpublication after a transient failure. Its reporting permissions, recipients
and repeat-alert policy are not yet defined. Existing
`notificationOutbox.service.js`/`notificationOutbox.model.js` provide durable
per-recipient deduplication and retryable delivery. The installed
`express-rate-limit` and existing auth middlewares can protect the reporting
route; a new queue or dependency is not warranted.

The proposed contract, awaiting user confirmation, is a published YouTube-only
reporting route for users/guests through `protectUserOrGuest`, bounded
allowlisted reasons with no raw URLs/error text/reporter identity stored,
rate limiting, alerts to active super admins and active admins with `VIDEOS`,
and one alert per Video/current YouTube ID/recipient/UTC day through the existing
outbox. Reports remain untrusted hints, never publication authority. The Public
Videos service and reporting HTTP route are proposed test seams using fake
external database/notification adapters. TDD requires confirming those seams
before writing tests. No implementation/tests or live notification/provider
calls were made in this inspection; V6.07 remains unchecked.

### V4.06 contract/cache review checkpoint — 2026-10-02

- Reviewed Q138 across initial readiness, Product replacement, activation and
  renaming, feed visibility, poster attachment, editorial publication/cutover,
  explicit video deletion, whole Product deletion and identity-specific saves.
  The current transition/cache matrix is in `PRODUCT_MEDIA_CONTRACT_PLAN.md`.
- Confirmed that `getProductByIdService` checks public Product activity before
  a base-cache lookup and projects `media` afterward using fresh placement,
  Product and active-asset reads. Cards/list/search DTOs remain image-only.
  Product Video transition effects stay in services, after persistence;
  existing Product update/delete paths invalidate Product caches after save.
- Videos lists/feed/detail/saved reads have no shared cache to invalidate.
  They query current eligible owners, media and covers and calculate typed
  identity state per request. Poster attachment also uses fresh projections.
  Public detail/read/playback controllers preserve `private, no-store`.
  No derived cache, new dependency, architecture change or enum cleanup was
  needed. The final enum cleanup and user-defined FE document remain later tasks.
- Playback grants recheck current eligibility/generation before returning a
  signed URL, but already-issued grants are not revoked by cache invalidation,
  flag rollback or unpublish. Their configured lifetime is at most 900 seconds;
  provider removal may end access sooner. This limitation is now explicit.
- Verification: 81/81 existing focused tests passed across product media,
  Product/Reel playback, public Video service/repository/HTTP, Product Video
  post-persistence effects/replacement and poster tests. Command:
  `node --test --experimental-test-isolation=none --test-reporter=tap` with the
  nine corresponding test files. No source/test changes were made, so the
  earlier full Videos result of 519/519 is retained rather than rerun.
  Cache-hit composition was inspected in source; this run used fake or disabled
  external adapters, not real Redis/Mongo/Bunny/worker/device acceptance.
- No environment, flags, runtime, external provider/database state or Git
  publication changed. V4.06 is checked; V4.A and other live gates remain open.
  Next narrow implementation slice is V6.07 YouTube error reporting/staff alerts.

### Agreed completion sequence — 2026-10-02

Finish the remaining Videos backend implementation slices first. Then perform
a behavior-preserving enum cleanup across the module and its integration
points, followed by focused/full local verification and source review. Add
Videos enums to the existing `src/shared/constants/enums.js`, using its named
frozen-object convention; reuse existing roles and controls. Keep distinct
business lifecycles separate and preserve exact persisted/API values and each
schema's allowed subset. This is not a replacement of every string literal.
Only after that cleanup and verification, prepare the detailed frontend
Markdown handoff with the contents the user will specify then. Real provider,
database, worker and device acceptance remain explicit independent gates.
The actionable checkpoints are `FINAL.01` through `FINAL.04` in the tracker.

The Videos module owns editorial Video lifecycle, Product Video placement,
Video Asset lifecycle, saves, analytics, Bunny provider calls, and durable
provider work. Product code calls the Product Video service interface to
attach, list, replace, remove, and project media; it does not know Bunny or
BullMQ. The app mounts public/editorial/product routes, and a dedicated worker
executes provider operations by ID.

The source is now grouped under `src/domains/videos/{editorial,reels,productVideos,public,provider}`
with matching `test/domains/videos` groups. This was a file-and-import-only
organization pass: HTTP paths, Mongoose model names, and behavior were not
intentionally changed. All 215 focused Video tests passed through the direct
in-process runner after the move. The flat `test/domains/videos/*.test.js`
commands below record historical checkpoints, not the current test layout.

The current module uses routes to register middleware/validators and controller
handlers. Controllers map HTTP input/output; services own business workflows;
repositories/models own persistence. Input-validation helpers live in validators
and remain callable from services so internal callers retain the same checks.
Dependency-injected factories are retained for isolated tests. Historical dated
checkpoints below may refer to the former `.application.js` filenames; those
eleven files now use `.service.js` names.

The initial Bunny create call is request-coupled because an upload-session
response must contain TUS instructions. MongoDB records reservations first;
provider calls happen outside transactions. Partial or uncertain creation
persists compensating cleanup. BullMQ accelerates reconciliation and cleanup,
while a MongoDB sweeper recovers lost enqueueing or worker leases.

## Work packages and verification gates

| Package | Implementation outcome | Required gate |
| --- | --- | --- |
| V1: configuration and adapter | Four default-off switches, fail-closed startup validation, Bunny Stream adapter, redacted provider errors, no keys in logs or DTOs | Configuration tests for enabled/missing secrets and signed-only HLS; mocked provider status/timeout matrix |
| V2: durable media core | `VideoAsset`, `VideoProviderOperation`, `VideoUploadAttempt`; operation leases/retries/sweeper; dedicated `video-provider` BullMQ worker | Duplicate-job, Redis-down, expired-lease, process-restart, 404/2xx/4xx/5xx/timeout deletion tests |
| V3: Product Video write path | Product Video placement, batch reservation, idempotent TUS sessions, refresh/fallback, cancellation, replacement, explicit and cascade deletion | Three-slot concurrent-reservation test; partial-batch compensation; old-asset cutover; Q96 outcome matrix; product-delete cleanup durability |
| V4: public product media | Derived `media` on product detail only; gallery order; visibility flags; product feed projection; cache invalidation | Old `images` contract unchanged; image-only create has no Bunny call; inactive/zero-stock behavior; all-feed filtering; no signed URL in cache |
| V5: editorial Videos | YouTube validation/embed, Reel upload, separate approval/publication, pending change review, ordering, protected previews | Admin versus super-admin permission matrix; reviewed-edit isolation; reject/resubmit/cancel; initial approval versus Publish; stale-review race |
| V6: public Videos and saves | YouTube list/detail, reels-style feed, playback grants, guest/user saves, pagination | Guest/user isolation; unavailable saves; ordering; 15-minute token; visibility-switch matrix; public DTO excludes provider internals |
| V7: administration UI | Videos tab, review controls, Product create upload sessions, Product edit media controls, TUS concurrency/resume and status recovery | Browser tests of image-only path, two concurrent uploads, refresh/retry, and failure/cancel states |
| V8: analytics | Batched event ingestion, dedupe, daily aggregates, retention, admin reports | Event replay and rate-limit tests; qualified-view timing; no public counts; no location/viewer reports; unavailable YouTube metrics represented honestly |
| V9: mobile/canary | Flutter media gallery, YouTube WebView, reels feed, saves, signed HLS, version-gated release; provider and device canary | Portrait/landscape, Android/iOS signed playback, token expiry, WebView callbacks, interruption/resume, missed webhook, replacement/deletion, cleanup recovery |

V1/V2 are foundations. V3 and V5 can proceed after the foundation, while V4
depends on V3. V6 depends on V3/V5. V7 consumes V3/V5. V8 can start once the
public identity and playback-session interface is fixed. V9 follows all other
packages. Each package must keep feature switches off until its own tests pass.

## V3.12.3 Guarded Product Video orphan-cleanup adoption (2026-10-02)

- Added internal `recoverUncertainCreation({ videoId, replacementId? })` to the
  existing Product Video service. It requires the explicit factory option
  `allowOrphanCleanup: true`; the production getter retains the default `false`.
  Disabled recovery returns `not_enabled` before observation or queue work.
  No HTTP route, automatic worker invocation or environment flag was added.
- Moved orphan eligibility/tracking into
  `productVideos/productVideoOrphanRecovery.repository.js`, separate from
  setup-expiry handling. Shared eligibility reads are used for discovery and
  transaction-time rechecks. The twelve existing discovery tests pass before
  and after this behavior-preserving extraction; validators, services,
  repositories and routes retain their established responsibilities.
- Recovery first applies the existing exact provider inspection. Candidate
  adoption re-reads the failed, unissued, asset-unbound reservation inside the
  transaction and compares its library, marker and creation/failure timestamps
  with the inspected context. Changed ownership or context refuses adoption;
  any tracked library/GUID is excluded and the existing unique asset index is
  the final provider-identity race guard.
- The transaction creates a deleting Product Video Asset, conditionally binds
  it to the inactive initial placement or only the old failed replacement, and
  records `abandoned_upload_cleanup`. It does not revive a deleted product,
  make a failed placement active, switch a ready asset or clear a newer pending
  replacement. Existing batch-failure/replacement-setup dedupe keys also protect
  compensation for a late response from the original create request. No new
  model, schema field or dependency was needed.
- Queue dispatch uses the existing post-commit helper. Redis failure does not
  undo the persisted obligation; the existing sweeper and worker can process it.
  Provider deletion remains worker-owned, not part of the adoption transaction.
  A failed operation write or rejected database commit rolls back asset creation
  and reservation binding and never dispatches an uncommitted operation.
- Thirteen new recovery tests use the approved Product Video service interface,
  real local repositories/provider-operation/worker code and fake external
  database/provider/queue boundaries. They cover initial cleanup after product
  deletion, old replacement/new pending isolation, concurrent/repeated recovery,
  tracked GUID and stale-context races, rollback, a delayed commit barrier,
  Redis loss, provider rejection/retry, default-off behavior and late provider
  responses after setup expiry/adoption and foreign-GUID refusal. All 119 Product
  Video tests and the full Videos suite pass: 519 passed, zero failed.
- Independent concurrency/data-loss review found no new adoption-transaction
  defect, but identified a pre-existing initial batch-compensation hole: a late
  provider response could target an asset already tracked under another owner.
  The regression reproduced the unsafe path before the fix. `failBatch` now
  checks Product Video owner type and placement ID before mutating an existing
  asset, and repeats these identities in its update filter. An unexpected foreign
  GUID fails closed with the existing safe cleanup-persistence error; no foreign
  deletion intent, operation or queue dispatch is created. The reviewer confirmed
  this narrow guard closes the reported issue, with no remaining review blocker.
- Five changed JavaScript files pass syntax checks and all seven changed files
  pass scoped whitespace checks. Unrelated dirty work, including the previously
  reported `.env` whitespace, was preserved.
- Fake transactions serialize and roll back injected failures; they do not
  establish real MongoDB concurrency or unique-index enforcement. Real provider
  semantics, database/worker acceptance and explicitly approved automatic
  wiring remain V3.12.A. No live system calls, flag changes, worker startup,
  `.env` edits, deployment or Git publication occurred in this slice.

## V3.12.2 Read-only Product Video orphan discovery (2026-10-02)

- Added internal `inspectUncertainCreation({ videoId, replacementId? })` to the
  existing Product Video service. It is not mounted on an HTTP route or scheduled
  by a worker. Validation belongs to the existing validators file, reservation
  eligibility and local GUID tracking to the setup-recovery repository, and
  provider orchestration to the service. No new model, configuration or dependency.
- Initial inspection requires an inactive failed/removed, unissued placement
  with no attached assets or replacement and a matching failed, unissued batch.
  Replacement inspection requires the exact failed, unissued, asset-unbound
  replacement and its matching retained placement. Failure codes are restricted
  to provider-unavailable or setup-expired outcomes. These records can survive
  product deletion; inspecting an old failed replacement does not modify a ready
  placement or newer replacement.
- Shared the existing Reel provider inspection in
  `provider/bunnyOrphanInspection.service.js`. The 21 existing Reel discovery and
  recovery tests pass both before and after extraction. Public Reel interfaces,
  cleanup opt-in and queue behavior are unchanged. A subsequent regression
  additionally rejects missing/non-string search GUIDs as ambiguous before GET.
- The Bunny adapter's Product reservation search accepts only canonical initial
  or replacement markers. It uses one page of at most ten results, existing
  authenticated GET/timeout/redacted-error handling and no redirects. Search is
  only a hint: exact GET must match GUID, marker and library, creation time within
  the existing five-minute skew/fifteen-minute grace bounds, status zero and
  empty-media metadata. Any locally tracked library/GUID is excluded. UTC without
  a suffix and explicit timezone offsets retain the existing safe date behavior.
- Twelve tests cross the previously approved Product Video service interface
  using real local repository and Bunny adapter implementations plus fake
  database/HTTP boundaries. Read-only cases reject database writes, transaction
  starts, queue/cache work and provider writes. Coverage includes a lost create
  response followed by failure persistence, denied replay and successful exact
  discovery without reallocation. Full Videos suite: 506 passed, zero failed.
- Bounded independent read-only review found no actionable blockers. Seven
  changed JavaScript files pass syntax checks and all nine changed files pass
  scoped whitespace checks. The broader tracked-diff whitespace check reports
  unrelated existing trailing whitespace on `.env:31`; that file was not edited.
- A candidate is an observation, not deletion authorization. No-match is not
  proof of absence. Legacy human-readable titles are not heuristically matched.
  Provider/database exceptions still reject; no failed observation can silently
  authorize cleanup. Transactional race fencing/adoption is V3.12.3. Real
  MongoDB/Bunny acceptance, automatic wiring and rollout remain unverified and
  separately gated. `.env`, feature flags, workers and live systems were untouched.

## V3.12.1 Product Video reservation markers (2026-10-02)

- Initial creates now use `petyard-product-video:<placementId>` and replacement
  creates use `petyard-product-replacement:<replacementId>` as Bunny titles.
  TUS setup uses the same title. Both IDs already commit before provider calls;
  failure/setup recovery and whole-product deletion retain the reservation
  records. A replacement gets a new reservation ID even when its placement is
  reused, so generations cannot share a marker.
- Reused the existing Product Video service, transactional repositories and
  retained records. No new model, schema field, endpoint, dependency or recovery
  wiring was added. Client-facing title/description and gallery contracts are
  unchanged; provider markers are not included in service response DTOs.
- Two regression tests were observed failing on the former human-readable
  titles, then passing with canonical markers. They exercise the previously
  approved Product Video service seam with real local repository code and fake
  external database/provider boundaries. Focused upload/replacement tests pass
  20/20; the full Videos suite passes 494/494. These local checks do not prove
  real MongoDB transaction behavior or Bunny discovery/cleanup acceptance.
- This is an identification prerequisite, not completed orphan cleanup. Next is
  bounded read-only discovery followed by guarded transactional cleanup adoption.
  Do not infer permission to delete from a marker alone. Legacy human-readable
  titles are not rewritten or accepted through heuristic matching. All feature
  switches, `.env`, workers and live provider resources remain untouched.

## V3.10 Approved one-video repeat: incomplete outcome, cleanup confirmed (2026-10-02)

- Executed the user's separate approval for exactly one disposable synthetic
  video in library 754739. Reused the recorded 7,062-byte two-second MP4 and
  preserved the earlier private manifest. The ignored harness uses current
  provider imports and a new private run directory; it pulses middle bytes,
  cancels delayed writes on an early response/error, bounds PATCH to 20 seconds
  and caps processing request timeouts by the three-minute observation deadline.
  Preflight and bounded independent safety review preceded provider writes.
- Captured GUID `c938864b-4d47-4958-9255-f5bd82554196` immediately after create
  at `2026-10-02T00:01:57.712Z`. Initial partial PATCH returned 204 at offset
  3,531/7,062; HEAD reported incomplete and management GET status 0. Test-only
  original expiry was `00:03:57Z`.
- Final PATCH queued its first byte at `00:03:52.059Z`; TLS connected at
  `00:03:52.197Z`, before expiry. Six 128-byte chunks were queued at roughly
  one-second intervals through `00:03:58.101Z`. Bunny returned 408 at
  `00:03:58.211Z`, before the scheduled expiry+2 final bytes. The harness
  canceled them; no final-byte event or completed-offset response exists.
  Client queueing timestamps do not prove exact provider receipt times.
- Finish correctly exited 1 (`CANARY_PATCH_RESULT`). Terminal processing
  observation was not reached because the upload did not complete. This is
  inconclusive for B's earlier accepted late-PATCH outcome, not an excuse to
  generalize status 0/TUS 404 into abandonment or claim an expiry guarantee.
- Cleanup exact-GUID DELETE returned 200 at `00:03:58.639Z`; GET returned 404
  at `00:03:58.844Z`. A separate read-only GET after the canceled timer deadline
  returned 404 at `00:04:40.781Z` and exited 0. The allocation is consumed and
  confirmed absent. Private evidence:
  `scripts/bunny-tus-late-processing-canary/v3-10-approved-repeat-2026-10-02/private.json`.
- Environment and earlier-manifest hashes were unchanged; all four flags stayed
  false. No Product/Reel/database/Redis/worker/dashboard or production source/
  test changes occurred. Harness syntax/scoped document checks passed. The prior
  492-test result remains current for unchanged backend code; it was not rerun
  and does not prove live acceptance. V3.10/V3.11 remain incomplete. No further
  allocation is approved; require a distinct evidence hypothesis before another
  proposed live run. Next independent local slice is V3.12 uncertain Product
  Video creation recovery.

## V3.10 Abandonment evidence boundary recheck (2026-10-02)

- Inspected Q83/Q85/Q134/Q142, the expiry-recovery decision matrix, prior
  completed/in-flight canary outcomes, Product Video callbacks and transactional
  cleanup, provider reconciliation and worker wiring. Confirmed provider absence
  after the original deadline already has guarded transactional abandonment;
  processing/ready assets and the old ready replacement remain protected.
- The still-existing status-0 case remains unresolved. The earlier canary
  accepted full upload bytes, then returned TUS 404 while management GET still
  reported status 0; it was cleaned up before its eventual processing outcome.
  The separately approved follow-up returned 408 before byte completion, so it
  did not resolve that case. Both prior allocation scopes are consumed. Neither
  TUS expiry/404 nor a status-0 snapshot is evidence that an upload is safely
  abandoned, even at the local 24-hour deadline.
- Reran the unchanged abandonment/setup-recovery tests: **25 passed, 0 failed**.
  This confirms the recorded fake-adapter branches, not provider timing or actual
  MongoDB isolation. No source/tests, environment values, flags or external
  resources changed. V3.10 and automatic Q142 fallback remain incomplete.
- Proposed next provider gate, requiring separate approval: exactly one new
  labelled synthetic-video object in library 754739, using the existing tiny
  generated MP4; one controlled final PATCH spanning original authorization
  expiry, followed by at most three minutes of management processing observation
  if full byte completion succeeds. Use a fresh private manifest, preserve all
  prior evidence, retain the exact GUID before upload, and attempt exact-GUID
  deletion/absence confirmation afterward. No allocation retry is implied.
  Do not enable flags, start workers, create Product/Reel/database records or
  change the dashboard/environment. Encoding/storage costs may apply.
- A failed/incomplete or timed-out observation is inconclusive, not permission
  to delete arbitrary uploads or manufacture a 24-hour guarantee. Even a positive
  canary informs the decision matrix; further provider guarantees or a separately
  confirmed conservative policy may still be needed before V3.10 is complete.

## V2.07 Operation monitoring and retry local implementation (2026-10-02)

- The user approved global super-admin-only monitoring and the administration
  service/HTTP test seams, with real repositories and fake external MongoDB/
  BullMQ adapters. Added provider routes, controller, validators and service;
  reused the existing operation repository and its atomic immediate retry.
  Static provider-operation routes mount before editorial `/:id` routes.
- Implemented paginated status/type monitoring with newest-first stable tie
  ordering and a whitelist DTO. Safe timestamps include lease expiry, but never
  lease tokens/active-target identifiers, provider GUIDs, dedupe keys, asset/
  cover/storage identifiers, secrets or raw responses. Existing `protect`,
  super-admin role and control middleware run before validation. Services also
  reject non-super-admin internal callers. Existing app timestamp formatting
  remains unchanged.
- Retry changes only `needs_attention` to `pending` and makes it due now,
  preserving failure history and worker lease guards. MongoDB commits before
  queue dispatch. Redis failure returns 202 with `queued: false`, records a safe
  queue diagnostic when possible and leaves work sweepable. Database failure
  returns sanitized 503; absent/non-retryable operations return 404/409.
  No force-completion, lease reset or synchronous provider execution was added.
- TDD tracer slices for monitoring, lost-enqueue retry and HTTP access failed
  before their respective implementation and passed afterward. Nine focused
  service/HTTP tests now pass. Full Videos verification passed **492/492**,
  including the sixth route/controller and production getter construction.
  HTTP tests use real JWT/protect/role/account checks, replacing only the external
  Mongo driver read with synthetic accounts and restoring transient test settings.
- Independent read-only review checked authorization, atomic retry and durable
  queue ordering. Its DTO concern treated all lease metadata as excluded; main
  review checked the approved preparation, which excludes tokens/identifiers and
  permits safe timestamps. Lease expiry remains explicitly documented and tested
  as a monitoring timestamp; no unresolved blocking issue remains in that scope.
- No new dependency, environment file change, live provider/database/Redis call,
  worker startup, flag change or rollout occurred. V2's local backend slices are
  complete; V2.A/V9.A7 and frontend/device gates remain open. Automatic orphan
  recovery stays disabled/unwired. Next narrow reliability slice: V3.10 Product
  Video abandonment for still-existing provider objects; inspect accepted rules
  and available provider evidence before changing recovery behavior.

## V2.07 Operation monitoring and retry preparation (2026-10-02)

- Inspected Q109, ADR-0003, the existing operation service/repository/model,
  queue dispatch and staff authentication. Immediate retry already has an atomic
  `needs_attention`-only transition to `pending`, preserving failure history and
  the worker's lease guards. Reuse that behavior instead of creating a second
  retry mechanism. A retry request never calls Bunny synchronously.
- Proposed protected endpoints: `GET /api/v1/videos/admin/provider-operations`
  with the existing page/limit convention and optional status/type filters, and
  `POST /api/v1/videos/admin/provider-operations/:operationId/retry` with no body
  fields. Register static administration paths before editorial `/:id` routes;
  retain separate provider routes/controller/validators/service/repository
  responsibilities and the existing `protect`/role/control middleware.
- Return only safe operation IDs, types, statuses, failure counts, scheduled/
  lifecycle timestamps and sanitized error codes. Do not expose provider GUIDs,
  dedupe keys, lease tokens, storage identifiers, credentials or raw responses.
  Persist the due-state transition before enqueueing; Redis failure must leave
  the operation recoverable, not turn it back into `needs_attention`.
- Q109 confirms super-admin-only immediate retry but does not define global
  monitoring visibility. Proposed initial boundary: global monitoring is also
  super-admin-only, because the collection includes Product Video and cleanup
  work beyond an individual editor's content. This proposal awaits confirmation;
  do not silently grant global access to admins with `VIDEOS`.
- Proposed TDD seams: provider-operation administration service and HTTP routes,
  with real repositories and fake external MongoDB/BullMQ adapters. Confirm these
  seams before writing tests. No implementation or tests changed in this
  preparation step; the preceding 483-test result remains the last recorded
  verification for unchanged code. No external writes or rollout are authorized.

## V2.06 Signed webhook local implementation (2026-10-02)

- The user approved the webhook HTTP route and service as test boundaries, using
  real repositories with fake external MongoDB/BullMQ adapters. Implemented
  `POST /api/v1/integrations/bunny-stream/webhook` in the existing provider folder,
  with separate routes, controller, middleware/validators, service and repository.
- The app captures original JSON bytes before its general parsers, while keeping
  the existing downstream security middleware. The endpoint validates the exact
  v1 HMAC-SHA256 signature with the existing Read-Only API key before database
  access, bounds input to 16 KiB and verifies library, GUID and status fields.
  It uses signature authentication rather than human JWT middleware; existing
  staff, public and guest/user authentication remains unchanged.
- Only known, non-deleting Reel/Product Video assets produce a durable `reconcile`
  operation. Its dedupe key includes the configured library and raw-body SHA256.
  Exact retries reuse the operation, including across service reconstruction;
  completed operations are not re-enqueued. Deduplication lasts for the operation's
  retention (currently 90 days after completion), not forever. Differently formatted
  signed JSON can produce separate hints. Bunny v1 has no signed timestamp/event
  identifier, so the endpoint cannot prove freshness.
- Persistence precedes queue dispatch. Database failure returns sanitized 503;
  Redis failure still returns 202 after durable work exists, leaving the operation
  recoverable by the existing sweeper. The HTTP acknowledgement hides target
  existence, operation IDs and queue state. No callback status directly changes
  asset readiness or editorial publication; the worker independently fetches and
  applies guarded authoritative provider observations.
- Verification: 10 focused webhook service/HTTP tests and the full Videos suite
  passed, **483/483**. Coverage includes signature tampering, raw bytes through
  JSON/form parsers and sanitizers, malformed/oversized/compressed input,
  wrong-library/unknown/deleting targets, persistence and Redis failure,
  exact-replay deduplication and completed-operation handling. The architecture
  test now includes the fifth route/controller and production webhook service
  construction without provider calls. Independent read-only security review
  found no blocking issue. Early retry enqueueing can be skipped by the worker's
  backoff claim guard; the durable sweeper retains the obligation.
- No dependency, environment value, feature flag, external database/provider
  resource, worker startup or Bunny dashboard setting changed. Automatic orphan
  recovery remains disabled/unwired. Production webhook configuration and actual
  MongoDB/Redis/worker acceptance remain V9.A7/V2.A. Next local slice is V2.07
  staff monitoring and super-admin retry, with test-boundary confirmation first.

## V2.06 Signed webhook preparation (2026-10-02)

- Continued from the completed narrow V5.15 gate. Inspected current app parsing,
  route mounting, provider operations/runtime and the accepted Q111/configuration
  plan. V2.06 is the next local implementation slice; no webhook implementation
  or new tests have been written before confirming its test boundaries.
- Rechecked [Bunny's official webhook documentation](https://bunny.net/docs/stream/webhooks):
  v1 HMAC-SHA256 signs the exact raw request body using the library Read-Only API
  key. Require the version/algorithm/signature headers and constant-time comparison.
  The v1 signature does not include a timestamp or event ID; do not invent a
  provider freshness guarantee. Deduplication and bounded ingestion remain necessary.
- Use the planned `POST /api/v1/integrations/bunny-stream/webhook` server-to-server
  boundary. Preserve raw bytes before the app's existing JSON parser. Signature
  authentication replaces human JWT authentication here; staff/user routes keep
  their existing `protect`/`optionalProtect`/role/control middleware.
- Keep routes, middleware/validators, controller, service and repository
  responsibilities separate under the existing Videos provider folder. Reuse
  durable reconciliation operations and post-commit enqueueing. Verify configured
  library and known asset identity; never publish or change asset readiness from
  callback status alone. Redis loss must leave durable work sweepable.
- Proposed test boundaries: webhook HTTP route and service with real repositories
  and fake external MongoDB/BullMQ adapters. Cover signature tampering and raw-byte
  preservation, malformed/wrong-library/unknown-target hints, deduplication,
  persistence failure and lost enqueueing. No real Bunny calls, database writes,
  worker startup or dashboard configuration are part of this local slice.
- TDD boundary confirmation is pending. The preceding 473-test result remains
  current for unchanged production/test code; no tests were rerun for this planning
  step. Flags and automatic orphan recovery remain disabled/unwired. Do not
  configure the production webhook URL before separate endpoint/deployment
  acceptance and explicit authorization.

## V5.15 Approved live repeat: positive candidate and cleanup passed (2026-10-02)

- The user separately approved exactly one empty Bunny video, marker discovery
  and exact cleanup after the local timestamp correction. Reused the reviewed
  harness with only distinct manifest/temporary filenames; preserved the prior
  failed-run evidence. Fresh preflight confirmed library `754739` and all four
  flags false. Syntax and ten zero-network safety checks passed.
- The real read-only orphan inspection returned `candidate` on its first search,
  with independently retained GUID `1c97601a-63b2-4aa4-911b-1bd79845a6cc` and marker
  `petyard-reel-session:f58d00595d7c2b4365eaeecd`. Bunny again returned an unzoned
  upload timestamp; the corrected parser passed the unchanged eligibility guards.
  The inspection was provider-only with synthetic context, not real database
  adoption or production ownership verification.
- Cleanup rechecked exact GUID/title/library. DELETE returned HTTP `200`, then
  exact-GUID GET returned `404`. The one empty test video is permanently removed.
  The run exited `0`: one POST, one search, four GETs and one DELETE, with no
  uncertain allocation or unresolved cleanup. Evidence is in
  `BUNNY_REEL_ORPHAN_CANARY_PLAN.md` and its ignored repeat manifest.
- V5.15.3 and the narrow V5.15 validation task are checked. Recovery remains
  default-off/unwired. Real MongoDB transactions/index races, Redis, standalone
  worker and frontend/device release gates are not closed by this proof.
- No media/TUS, MongoDB/Redis writes, worker startup, flags, library settings,
  packages or Git history changed. `.env` byte comparison passed. Production and
  test code were unchanged; the preceding full 473-test and two-timezone focused
  results were reused. The repeat's approval is consumed; no additional provider
  allocation, deployment or feature enablement is authorized.

## V5.15 Local provider timestamp correction (2026-10-02)

- Continued only the local fix after the consumed live canary. The user correctly
  identified the Egypt UTC+3 offset; `egyptTimezone.js` formats outgoing Express
  JSON only and was not in this incoming provider path. Preserved that utility,
  all existing work and the feature gates. No global timezone change was made.
- Reused the user-confirmed discovery/recovery and provider adapter seams. Added
  a recorded-response regression using real discovery, real recovery repository
  with fake MongoDB, and the real Bunny adapter with fake HTTP. It first failed
  on the Cairo host with the same `requires_review` result as the live canary.
- Added a private parser in the existing discovery file: only ISO-shaped Bunny
  upload timestamps are accepted; the observed unzoned provider values are treated
  as UTC, explicit offsets are preserved, and the existing eligibility checks
  remain intact. This provider-specific interpretation follows the captured
  UTC-aligned response and Bunny's official UTC example; it is not a generic
  conversion rule for arbitrary unzoned dates.
- Independent review found that JavaScript can normalize impossible calendar
  dates. A second failing regression demonstrated non-leap-year February 29
  becoming March 1 inside the allowed window. Calendar/time components must now
  round-trip unchanged before offset application. Corrective review reported
  no remaining actionable findings.
- Four new integration tests cover the captured response, explicit offsets and
  UTC-equivalent forms, missing/malformed/out-of-window dates, and calendar rollover.
  Focused discovery/integration/adapter tests passed **50/50 in both Cairo and UTC**.
  Full Videos suite passed **473/473**. Source/test syntax, five scoped whitespace
  checks and tracked `git diff --check` passed. Test-only timezone overrides were
  restored after each run.
- `.env` still matches its pre-canary hash. No provider calls, MongoDB/Redis writes,
  worker startup, package or Git-history changes occurred. Automatic recovery is
  still default-off/unwired. The prior live failure remains a failure; V5.15.3
  and its parent stay unchecked pending a new explicitly approved one-empty-video
  repeat with exact cleanup and a distinct manifest.

## V5.15 Live orphan canary: cleanup passed, timestamp gate failed (2026-10-02)

- The user explicitly approved one empty test video in configured library `754739`,
  with marker search and exact-GUID cleanup only. Prepared an ignored guarded
  harness and private manifest; syntax, ten zero-network safety checks, preflight
  and independent read-only safety review passed before execution.
- The single allocation returned GUID `ed494595-81ed-4e64-aba5-31f2fa69c97e`.
  Real read-only orphan inspection found the exact marker but returned
  `requires_review`, so V5.15.3 and its parent remain unchecked.
- Captured provider metadata matched identity/library and all empty-resource
  guards. Its `dateUploaded` omitted a timezone suffix. Offline diagnosis on
  `Africa/Cairo` confirmed that the existing `Date.parse` interpreted it three
  hours earlier, outside the allowed time window. Interpreting the captured
  timestamp as UTC places it 250 ms after request start; this is observational
  evidence, not a guarantee about every unzoned provider value.
- Cleanup rechecked exact marker/library/GUID immediately before DELETE. Bunny
  returned HTTP `200`, then authoritative exact-GUID GET `404`. The only created
  empty resource is permanently removed; there is no unresolved cleanup target.
  The run used one POST, one search, four GETs and one DELETE; no media or TUS.
- Harness exit `1` correctly records failed candidate acceptance. Details and
  next regression/fix boundary are in `BUNNY_REEL_ORPHAN_CANARY_PLAN.md`.
  The one allocation approval is consumed; a repeat requires new explicit approval.
- No production source, `.env`, flags, library settings, MongoDB/Redis, normal
  worker, packages or Git history changed. `.env` byte comparison passed. The
  existing 469-test result was not rerun because production/test code is unchanged;
  it does not supersede this failed live proof. Automatic recovery stays disabled
  and unwired. Next is timezone-independent provider timestamp handling and a
  recorded-response regression, not feature enablement.

## V5.15 Local orphan recovery integration proof (2026-10-02)

- The user confirmed discovery/recovery and provider runtime as the test
  boundaries, using the real recovery repository and fake external MongoDB,
  Bunny and queue adapters. No live connection string or external writes were
  needed for this local slice.
- Added `test/domains/videos/reels/reelOrphanRecoveryIntegration.test.js`,
  reusing the existing fake database and real upload/recovery, operation and
  asset-observation implementations. Only external database/provider/queue
  adapters inject failures or interleavings; the recovery repository is not mocked.
- Eight tests passed: exact adoption without an editorial owner; queue-loss
  sweeping and cleanup; duplicate recovery; persistence rollback; tracked GUID
  and stale-session rejection; provider retry; strict search/metadata guards;
  and disabled/non-applicable recovery without provider work. Worker processing
  removes the intended provider object and preserves an unrelated one.
- Full Videos suite: **469 passed, 0 failed**. Existing production code satisfied
  these tests without modification; no artificial failing condition was added
  to justify changing the implementation.
- The new test file passed syntax checking; all four touched test/document files
  passed scoped whitespace checks, and tracked `git diff --check` passed.
  Independent read-only review confirmed that the rollback assertions detect
  leaked assets, session claims and due operations through the approved interfaces;
  no actionable gap remained in that review.
- V5.15.2 is checked locally; parent V5.15 and live canary V5.15.3 remain
  unchecked. The fake transaction fixture serializes transactions and does not
  prove real MongoDB concurrency or unique indexes. The live positive-match
  canary remains a separate approval scope, as documented in
  `BUNNY_REEL_ORPHAN_CANARY_PLAN.md`. Recovery is still default-off and unwired.
- Preserved the dirty D: checkout. No production source, environment/flag,
  provider/library, MongoDB/Redis, worker process, package or Git-history changes.

## V5.15 Orphan recovery acceptance preparation (2026-10-02)

- Rechecked the current dirty D: checkout and V5.14 checkpoint, preserving all
  existing work. Inspected exact-marker discovery, transactional orphan adoption,
  typed cleanup operations and worker processing. Recovery remains default-off
  and no worker or route invokes the opt-in path.
- Current focused verification: discovery, Reel upload repository and Bunny
  adapter tests **57 passed, 0 failed**. The previous full 461-test checkpoint
  remains historical evidence; the full suite was not rerun for this read-only
  inspection/documentation slice.
- Existing tests largely fake internal repository responses. Requested user
  confirmation to verify discovery/recovery and provider runtime through the
  real recovery repository with fake external MongoDB/provider/queue adapters.
  No new tests were written before that confirmation.
- Prepared `BUNNY_REEL_ORPHAN_CANARY_PLAN.md`: local integration proof and a
  distinct, separately approved one-empty-video provider canary. The canary uses
  the existing read-only inspection interface and independently retained exact
  GUID for cleanup; it does not write production MongoDB/Redis or start workers.
- V5.15 remains unchecked. A live positive marker match and exact-GUID cleanup,
  real MongoDB transaction/index behavior and rollout approval remain unverified.
  No product code, secrets, flags, external resources or Git history changed.

## V5.14 Permanent editorial deletion (2026-10-01)

- The user confirmed Q162: editorial removal is immediate after local cleanup
  persistence, even when Bunny is unavailable. Individual Product Video removal
  continues to wait for provider acceptance/confirmed absence (Q93/Q96).
- Implemented super-admin-only `DELETE /api/v1/videos/admin/:id`, exact
  `{ revision }` input, strict ID/revision validation, safe `202 { data:
  { videoId, status: "removed" } }` and private/no-store response. Existing
  protection/control middleware runs before action validation; the service
  independently checks authority. Missing owners are idempotent, stale revisions
  and inconsistent media references conflict. No provider identity is client input.
- The deletion repository uses one transaction to remove the Video and all saves,
  mark all owned Reel assets/covers deleting, record provider/image cleanup
  operations, and fail reserving/issued sessions. Independent cleanup records and
  exact upload markers survive. Queue dispatch is service-owned after commit;
  provider calls stay in the existing worker. Persistence failure restores all
  local state, while queue/provider failure cannot restore the removed owner.
- Saving now writes a private `associationRevision` fence and its association in
  one transaction. Duplicate-key recovery retries outside the aborted transaction
  and rechecks the owner. Editorial revisions/timestamps remain unchanged by saves.
  The private counter is excluded from presentation and snapshot replacement.
- Independent review found a cover reservation/deletion race: a read-only owner
  check could allow a cover to commit after deletion's cover scan. Reservation now
  shares the private owner write fence, preserving editorial edit revisions. A
  regression failed against the read-only check and passed after this correction.
- Approved test seams: editorial service/HTTP, public reads/saves and provider
  worker, with fake database/provider/queue adapters only. Fourteen deletion tests
  cover permission/validation, lifecycle states, revision/reference conflicts,
  transaction rollback, user/guest saves and save races, queue/Bunny retry,
  active/pending/detached assets and covers, late GUID compensation, late cover PUT
  settlement and stale lifecycle writes. Full Videos suite: **461 passed, 0 failed**.
- Final checks: 13 changed JavaScript files passed syntax checks; all 17 touched
  source/test/document files passed scoped whitespace checks, and tracked
  `git diff --check` exited successfully. Independent review confirmed the cover
  reservation correction and found no remaining actionable issue in that fix.
- Real Mongo transaction/write-conflict behavior, standalone worker/Redis and
  Bunny/storage/device acceptance remain unverified. The overlapping external
  model test complements the serialized fake transaction fixture; neither proves
  live Mongo isolation. Known late GUIDs compensate through existing `failSetup`;
  unknown GUID discovery remains default-off/unwired under V5.15. Previously issued
  HLS URLs retain Q157's expiry bound; no instant CDN revocation is promised.
- Preserved existing unrelated changes in the D: checkout. No environment/flag,
  package, deployment, live database/Redis, provider or Git-history changes.

## V5.13.3 Private draft arrangement (2026-10-01)

- The user confirmed Q161: a separate `draftPosition` used only in filtered
  administration draft lists, existing draft-edit permissions, independent
  YouTube/Reel order and no automatic promotion into public ordering. The service
  and HTTP boundaries with fake persistence and no provider/Redis calls were
  explicitly approved for TDD.
- Added `PATCH /api/v1/videos/admin/:id/draft-position` through the existing
  validator/controller/service/repository layers. Existing `protect`, roles and
  control middleware run first. The service reuses `editMode`, including the admin
  restriction on automatic Reel drafts and competing pending changes. Public
  positions still require super-admin authority.
- Exact `{ draftPosition, revision }` validation permits a safe non-negative
  position or `null`. The repository makes one conditional update on ID, editorial
  kind, draft state and expected revision; only draft position/revision change.
  The response contains ID, committed position and new revision, private/no-store.
  A shared revision conflict prevents stale arrangement and lifecycle writes.
- The existing admin list accepts the paired `kind=youtube|reel&status=draft`
  filters. A facet counts and paginates only that section, sorting positioned
  drafts first, then position, newest creation and ID. Equal/missing/null positions
  have deterministic fallback; unfiltered listing retains its original order.
  The model adds an optional field without a backfill or new index. Approval and
  publication preserve, but never promote, its private value. Public projection
  and Product code remain unchanged.
- TDD red/green evidence: arrangement first failed because the service action
  was absent; filtered listing returned mixed records in the wrong order; HTTP
  failed with 404 before route wiring. Twelve new service/HTTP tests now cover
  permissions, malformed input, both sections, clearing, ties, pagination, empty
  sections, unchanged unfiltered listing, stale/concurrent writes, submission
  conflicts and publication isolation. The external database fake reuses existing
  persistence fixtures, adds skip support, and validates update documents with
  the real Mongoose schema. Provider/queue calls fail the arrangement tests.
- Verification: full Videos suite **447 passed, 0 failed**. Eight changed JavaScript
  files pass syntax checks; tracked and twelve touched-file whitespace checks pass.
  Independent read-only review found no actionable defects in authorization,
  revision guards, private ordering or public projection isolation; it did not
  run tests or inspect live services. Real MongoDB queries,
  concurrency, indexes and the administration frontend remain unverified. No
  external writes, environment changes, new dependencies, workers, deployment or
  Git history changes occurred. Unrelated work is preserved. Backend V5.13 is
  locally complete; V5.14 permanent editorial deletion is next. Upload/public
  rollout gates remain closed.

## V5.13.2 Atomic bulk public ordering (2026-10-01)

- Added `PATCH /api/v1/videos/admin/positions` through the existing editorial
  route, validator, controller, service and repository layers. Existing `protect`,
  staff role/control checks and the super-admin action check run before validation.
  Internal service calls retain the super-admin check and input validation.
- A batch selects one `youtube` or `reel` namespace and 1–100 distinct published
  Videos. Each entry supplies its current revision and a safe non-negative position
  or `null`. Exact-field validation rejects malformed/duplicate/oversized batches.
  Partial lists and equal positions preserve existing ordering semantics; omitted
  Videos are not shifted, and Product projections/gallery order are unchanged.
- The repository uses one MongoDB transaction with conditional writes on ID,
  section, publication state and revision. Any unavailable or stale entry aborts
  all earlier writes. Only positions/revisions change; pending proposals, metadata,
  covers and media references are preserved. The post-commit response contains
  ordered IDs, positions and new revisions, with private/no-store caching.
- TDD evidence: the service test first failed because the bulk action did not
  exist; the HTTP test first failed because `/positions` reached the generic ID
  route. Both passed after implementation. Ten new service/HTTP tests cover both
  sections, rollback, overlapping fake transactions, hidden/missing targets,
  clearing positions, exact validation, 100-entry limits, real role/control
  middleware, production unauthenticated access and committed response revisions.
  Full Videos suite: **435 passed, 0 failed**. Six changed JavaScript files pass
  syntax checks; tracked and nine touched-file whitespace checks pass. Independent
  read-only review found no actionable defects in authorization, validation,
  transaction retry handling or shared revision guards; it did not run tests.
  The fake transaction fixture
  serializes concurrent requests; this is not proof of real MongoDB concurrency.
- No provider/queue calls, dependencies, schema changes, environment changes,
  workers, deployment or Git history changes were needed. Unrelated work is
  preserved. V5.13.3 admin draft arrangement remains next, then V5.14 permanent
  deletion. Live database and frontend acceptance remain separate unchecked gates.

## Videos architecture follow-up fixes (2026-10-01)

The first alignment checkpoint below covered HTTP separation and wiring, not
every persistence boundary. A wider audit found residual mixed responsibilities
and two existing bugs. This follow-up fixes those findings without advancing
feature or release gates.

- Product and Reel upload services now honor `uploadAuthorizationTtlSeconds`,
  including initial TUS creation, replay, refresh and Product replacement.
  Production getters and the Product worker interface receive the validated
  Stream setting instead of assuming six hours. Three service-level regression
  tests cover a one-hour setting; defaults and resource/deadline limits remain.
- Provider-operation, asset-observation and poster queries are in dedicated
  repositories. Services retain validation, retry scheduling, snapshot policy,
  callbacks and external provider/storage workflows. Dedupe identity checks,
  duplicate-key recovery, lease fencing, monotonic asset updates and poster
  race protections are preserved.
- All Videos repositories now perform local persistence only. Transactions still
  record durable cleanup obligations before returning; committed results carry
  operation IDs for service-owned queue dispatch. Redis failures remain recoverable
  through the Mongo sweep. Existing tests were adapted to prove the service-owned
  effects, rather than removing the queue-after-commit assertions.
- Product cache invalidation is owned and injected by the Product Video service.
  Five repository paths previously bypassed their injected cache function;
  regressions now verify visibility, cancellation, accepted deletion, readiness
  and terminal failure through real repositories with fake database adapters.
  Explicit deletion requests still retain public media and caches until Bunny
  accepts deletion; this accepted boundary was independently rechecked.
- Product cascade deletion now has a service and transactional repository.
  The Product domain import is updated; image-only deletion is preserved, and
  Product removal, placement tombstones and cleanup obligations remain atomic.
- Admin/public pagination uses one validator. Position input validation lives in
  editorial validators; Reel readiness is a shared policy used by services and
  transactional persistence. Existing subfolders, HTTP paths, DTOs, middleware
  order, permissions, default-off flags and hard-off upload guards are unchanged.
- Verification: baseline **415/415**, final **425/425** local Videos tests;
  **114** relevant JavaScript files pass syntax checks. Relative imports and
  tracked/scoped-untracked whitespace checks pass. Independent read-only source
  review found no actionable defect in the changed provider, cascade, cache,
  lifecycle and receipt-consumer paths; it did not run live services.
- No packages were installed, environment values changed, external services
  contacted, workers started, commits made or deployments performed. Unrelated
  UI Builder work is preserved. Real Mongo/Redis/Bunny, frontend and deployment
  acceptance remain unverified by this refactor.

## Videos architecture alignment (2026-10-01)

- The user requested consistency with PetYard's existing module architecture.
  Preserved the editorial, reels, productVideos, public and provider subfolders.
  Moved HTTP handlers into four controllers, eleven application files into
  services, reusable input checks into four validators, and upload guards/parser
  configuration into two middleware files. Updated all affected source, worker,
  Product integration and test imports. No parallel application/service layer
  or new dependency was introduced.
- Production dependency construction now lives in service getters, outside
  routes. Preserved lazy construction, synchronous Product Video getters and
  asynchronous editorial/public getters. The existing injected service and
  controller factories remain test seams; business rules, persistence boundaries,
  provider operations and transaction protections are unchanged.
- Staff routes retain the existing `protect`, `allowedTo` and enabled-control
  middleware. Review/publication/position actions retain super-admin restrictions.
  Upload readiness guards remain after authorization and before upload parsing.
  Public Videos use `optionalProtect`; saves use `protectUserOrGuest` for separate
  user/guest identities.
- A follow-up middleware check found that public Product Video playback lacked
  `optionalProtect`. Added that existing middleware to match public Videos.
  Anonymous playback is still allowed, but a supplied invalid bearer token now
  returns 401 before service execution. Reproduced the missing check (expected
  401, actual 200), then verified the fix. This is the only intended HTTP behavior
  correction in the architecture pass; endpoint paths and response shapes remain
  unchanged.
- Verification: baseline **410/410**, final **415/415** local Videos tests. Added
  architecture/import checks, synthetic production-constructor checks, invalid
  replacement-validation checks and real default-middleware HTTP checks; extended
  Product playback HTTP coverage. Service construction makes no provider requests.
  Independent source review found no concrete wiring, middleware-order or import
  regression. Syntax and tracked/scoped-untracked whitespace checks also passed.
- No environment flags, secrets, unrelated UI Builder work, live services, worker
  processes, deployment or Git history were changed. Existing MongoDB/Redis/Bunny
  and client acceptance gates remain pending. This checkpoint is not feature
  enablement and does not advance unfinished feature tasks.

## V5.13.1 Single-item Reel public ordering (2026-10-01)

- Reused the existing super-admin position application action and protected
  PATCH route for published editorial Reels as well as YouTube Videos. No new
  route, service, collection, dependency or provider call was needed. Hidden
  editorial content and Product Video projections remain invalid targets.
- Reproduced a shared schema defect: the API accepted clearing with `null`, but
  `Number.isSafeInteger` rejected that value during Mongoose validation. Updated
  the optional position validator to accept null/missing values while retaining
  non-negative safe-integer validation. Actual model-validation tests cover both
  editorial kinds, including zero, null and invalid numeric values.
- Position writes keep the existing revision CAS and update validators. Public
  media, publication timestamps/state and pending metadata/cover/replacement
  content are preserved. Reviewed and automatic replacement cutovers retain a
  newer position; updates during verification invalidate stale cutover attempts.
- Confirmed the existing Reel aggregation already sorts positioned content first
  by position, then publication time/ID descending, with missing/null positions
  using newest-publication fallback. Equal positions use those tie-breakers;
  setting one item does not shift others. Mixed feeds ignore manual positions
  and remain newest-first; YouTube ordering is independent. Public reads and
  Product/save ordering required no source changes.
- Verification: **7 new tests; full Videos suite 410/410**, syntax and
  tracked/scoped-untracked whitespace checks. HTTP tests use the actual role/
  control middleware and application; super admins retain their existing control
  exemption. Repository tests assert the revision filter and validators; public
  tests inspect the generated aggregation. These fake-persistence checks do not
  prove real Mongo sorting/concurrency. No live service or worker was started.
- Boundaries: V5.13 is still partial. Atomic bulk/drag public ordering and admin
  draft arrangement remain V5.13.2/V5.13.3, followed by permanent deletion.
  No environment, rollout guard, unrelated work, deployment or Git history was
  changed. Real persistence and client acceptance remain separate gates.

## V5.11.3 Custom cover attachment, review and fallback (2026-10-01)

- Connected the existing portrait store and durable generations to protected
  cover upload/removal routes. Multipart input accepts one `cover` file, no text
  fields, and a 5 MiB cap. Existing staff role/`VIDEOS` controls apply before
  parsing; application checks review ownership/state before any storage write.
  Metadata PATCH continues rejecting client-supplied cover identifiers/URLs.
- Admin changes to approved/published/unpublished content remain in the author's
  pending proposal. Metadata edits preserve the proposed cover and any replacement
  upload/rejection deadline. Review promotion preserves publication state; initial
  drafts use their existing workflow. Super admins can immediately edit without
  a competing proposal; their own automatic replacement copies stay synchronized.
- Shared reference persistence updates the Video revision and each owned,
  settled, non-deleting cover in one Mongo transaction. New generations also
  require the uploading actor and an unexpired reservation. A reference revision
  increment fences attachment against cleanup. Retiring the last active/pending
  reference marks deleting and records a durable image operation in that same
  transaction, with best-effort queue notification only after commit.
- Combined Reel approval switches metadata, cover and active Stream asset
  atomically. Whole-proposal cancellation retires only unreferenced proposed
  covers/media, never the active public version. Rejected Stream media expiry
  preserves retained cover/metadata. Failed attachment schedules guarded cleanup;
  a failed compensation transaction leaves the generation sweepable.
- Protected detail/cover-edit responses derive nullable current/proposed cover
  URLs. The admin list remains unchanged; review uses detail. Public lists,
  mixed feeds, detail and saves bulk-resolve only attached active covers owned
  by their Video, never pending references. YouTube thumbnails and copied Reel
  posters remain the fallback; Product Video posters and public DTO fields are
  unchanged. Storage descriptors and pending content stay private.
- Verification: **16 new tests; full Videos suite 403/403** and **6/6 shared image
  tests**, plus syntax and tracked/untracked whitespace checks. New proofs cover
  isolation, metadata preservation, stale revisions, ownership/expiry fences,
  transactional rollback, combined replacement/cancellation, retained covers on
  Stream expiry, public fallback and HTTP authorization/multipart limits. An
  independent read-only source review found no actionable defects; it did not
  run tests or inspect live services.
- Boundaries: new cover POST has a default hard-off readiness guard. DELETE and
  cancellation remain manageable for existing generations. No environment flag,
  dependency, live service, deployment or Git history was changed. Real Mongo
  transactions/indexes, worker restart and Bunny delivery/cleanup remain unverified
  under V5.A/V9; permanently unknown upload resolution remains pending under V2.07.
  Do not enable uploads from these local checks. Next safe local work is V5.13
  ordering, then V5.14 permanent deletion; preserve unrelated UI Builder changes.

## V5.11.2 Durable cover staging and cleanup (2026-10-01)

- Added a separate `EditorialCover` collection rather than inventing a Stream
  GUID for image-only work. Each fresh server-generated generation records its
  Video owner, uploading administrator, non-secret storage zone/endpoint/CDN
  identity, processing deadline, descriptor and lifecycle state. No access key
  is stored. There is no TTL index that could discard unresolved cleanup.
- Internal staging validates the portrait before reservation, persists the
  generation before PUT, and records an exact deterministic descriptor with a
  state CAS. It does not expose an HTTP endpoint or attach a cover. An unattached
  upload has a five-minute request-processing deadline; this is not the lifetime
  of a published or pending cover. Failed reservation makes no provider write.
- Terminal failure, failed upload-result persistence, and expired unattached
  generations reuse Mongo transactions to record deletion intent and a durable
  Provider Operation together. Queue notification follows commit; Redis failure
  leaves Mongo work discoverable. Failed compensation persistence leaves the
  original reservation discoverable rather than issuing an untracked DELETE.
  The operation's immutable target is `coverId`, without Stream fields, and
  reuses the existing per-target lease, retry/backoff, sweeper and retention.
- Both scheduling and execution check active and pending editorial references.
  Cleanup uses the recorded storage identity and rejects changed configuration
  before PUT/DELETE, preventing wrong-zone cleanup. The known descriptor is not
  needed to derive the object key, and storage rejection remains retryable.
- An unknown PUT result is not guessed settled. The worker can attempt DELETE,
  but the obligation remains open until upload settlement was observed before
  that DELETE and is still current at confirmation. A producer finishing after
  an earlier cleanup requires another DELETE; neither stale leases nor a lost
  Mongo acknowledgement prove completion. Permanently unknown outcomes retain
  their tombstone/operation and reach `needs_attention`, with daily retry under
  the existing policy. Safe operator monitoring/resolution is still pending
  under V2.07; do not clear settlement manually without authoritative evidence.
- Added schema/index slots for `activeCoverId` and pending content `coverId` so
  reference guards are explicit. No existing metadata route accepts cover fields,
  and public default-cover DTOs remain unchanged. Future attachment/review writers
  must CAS/update the non-deleting cover in the same transaction as the Video
  reference; reference-only writes are unsafe. V5.11.3 is the next slice.
- Worker source creates the cover indexes, dispatches image cleanup without any
  Stream call, and sweeps expired unattached generations with bounded selection
  and fresh rechecks. The worker was not started against real services.
- Verification: **22 new tests; full Videos suite 387/387**, **6/6 shared image
  tests**, syntax and tracked/untracked whitespace checks. Tests use actual Sharp,
  schema validation, fake persistence/storage, simulated rollback and existing
  operation leases. They cover late PUT/settlement, uncertain outcomes, Redis
  loss, persistence failures, reference races, expired leases, storage changes,
  safe errors and bounds. An independent read-only source review found no concrete
  defect and reiterated the future atomic-attachment requirement. Real Mongo
  transaction/index behavior, standalone worker restart and Bunny interrupted
  upload/deletion behavior remain unverified. No environment, gates, dependencies,
  unrelated work, live systems, Git history or deployment was changed.

## V5.11.1 Portrait cover storage seam (2026-10-01)

- Added an internal editorial cover store using the existing Bunny public-image
  uploader. It accepts decoded, single-frame JPEG/PNG/WebP files up to 5 MiB and
  16 megapixels, with height greater than width after EXIF orientation. Portrait
  means any portrait aspect ratio; there is no forced 9:16 crop. Decoder failures,
  corrupt/truncated bodies, square/landscape images, animation and unsupported
  formats fail with safe `422 VIDEO_INVALID_COVER` before storage writes.
- The shared image uploader now has an opt-in portrait profile. It applies EXIF
  orientation and fits within 1080 by 1920 pixels without cropping or enlargement,
  producing WebP through the existing pipeline. Standard, tile and proof image
  behavior remains unchanged. The cover store requires Bunny configuration and
  does not fall back to Cloudinary.
- A server-generated cover-generation ID determines the exact object key under
  `petyard/video-covers`. Strict deletion derives that same key without needing
  a returned descriptor and propagates storage failure. Upload failures also
  propagate; this storage seam alone does not compensate or authorize writes.
  Its future caller must persist a fresh generation before PUT and must not reuse
  an existing generation for different content.
- Verification: **8 new tests; full Videos suite 365/365**, plus **6/6 shared
  image-upload tests**, syntax and whitespace checks. Tests use actual Sharp
  decoding/conversion and fake storage transport; no Bunny calls were made.
- V5.11 remains incomplete. No cover route, editorial schema/projection change,
  or worker wiring is exposed yet. Next: durable cover-generation records and
  cleanup, followed by reviewed attachment/removal, atomic Reel cutover and
  public default-cover fallback. Existing Stream operation identity cannot be
  reused by inventing a dummy video GUID for an image-only obligation.
  Four feature flags and the hard-off Reel upload guard remain unchanged.
  No environment, dependency, live system, commit, push or deployment changed.

## V5.12 Rejected replacement grace and whole-proposal cancellation (2026-10-01)

- Recorded confirmed Q160: rejecting an attached Reel replacement starts seven
  days of retention. Editing retains that deadline; successful resubmission
  stops rejected-state cleanup while under review. A later rejection starts
  a fresh seven days. Failed readiness/submission does not clear the deadline.
  The pending schema stores the deadline, with an ordinary lookup index rather
  than a TTL index that could delete the proposal without provider cleanup.
- The existing bounded worker sweep now recovers due rejected/draft changes.
  It rechecks the candidate's revision, active generation, pending asset/session,
  immutable author/previous asset, configured library and unapplied session in
  a Mongo transaction. Editing/resubmission/application/cancellation after
  selection prevents a stale cleanup. Existing rejected changes without an
  explicit deadline may use a valid recorded review timestamp; unknown dates
  remain untouched rather than guessing which media is safe to delete.
- Expiry detaches only replacement pointers, clears its timer/automatic authority,
  returns remaining metadata to draft and records `VIDEO_REJECTED_ASSET_EXPIRED`.
  The active asset/session, public metadata, publication state and ordering do
  not change. Exact-GUID cleanup and session/audit updates reuse transactional
  upload recovery; Redis enqueue follows commit and remains sweepable if lost.
- Existing `DELETE /api/v1/videos/admin/:id/pending-change` now cancels a whole
  attached proposal in one transaction, including reserving/processing/ready
  replacements in draft/review/rejected states. The author or super admin may
  cancel it; missing identity or another admin fails before cleanup. The proposal
  clears only with durable cleanup/session failure/audit records committed.
  Reference and generation guards prevent deleting active/adopted media;
  unsuccessful writes roll back. An unknown-GUID reserving session remains
  searchable for the existing late-response compensation path.
- Metadata-only YouTube/Reel cancellation still uses its existing revision CAS.
  Whole cancellation keeps the existing `200 { data: Video }` response and adds
  `Cache-Control: private, no-store`. It works when new-upload gates are closed;
  success means cleanup intent is durable, not that Bunny deletion is complete.
  Session-specific cancellation remains available when the editor wants to keep
  proposed metadata and cancel only its replacement upload.
- Verification: **8 new tests; full Videos suite 357/357**, syntax checks on
  changed source/tests/worker, and local HTTP proof with fake identities.
  Tests use fake persistence/provider adapters and simulated transaction rollback;
  they cover deadline boundaries, editing/resubmission/rejection rules, guarded
  legacy dates, authority, exact owner/library/session binding, stale sweep
  candidates, persistence failures, Redis-down recovery and closed upload gates.
  A read-only independent review found that editing a legacy rejected proposal
  could hide its inferred deadline. The sweep fallback now also covers editable
  drafts with a valid old review time; a regression test confirms the original
  deadline still applies after editing. Resubmitted changes remain excluded.
  Real Mongo transactions/indexes, standalone worker restart and Bunny cleanup
  remain unverified. No flags, secrets/config, packages, live systems, deployment,
  commit or push changed. Existing unrelated work was preserved.
- Next: V5.11 custom portrait covers, then ordering/deletion. V5 and Videos
  as a whole remain incomplete; completion of local V5.12 is not rollout approval.

## V5.10.2.2 Reel replacement review and cutover (2026-09-30)

- Replaced the temporary replacement-review refusal with pending-asset
  readiness and signed-preview verification for submit/approval. Active video
  preview cannot approve a replacement. Review still requires the proposal's
  admin author to submit and a super admin to approve; rejected proposals can
  be revised/resubmitted without touching public media.
- One lifecycle repository transaction handles approved and automatic cutover.
  It rechecks revision, current pending/session/author, previous asset, typed
  ownership, configured library, ready metadata and automatic authority when
  applicable. Metadata and active asset/session switch together without changing
  published/approved/unpublished status, ordering or publication time. Unpublish,
  cancellation and competing edits during the preview prevent a stale cutover.
- The same transaction clears the proposal, records session application and
  upload audit, verifies the old asset is unreferenced, marks its deletion intent
  and persists the exact-GUID cleanup operation. Failed persistence/CAS rolls
  back the switch. Enqueue follows commit; Redis failure leaves sweepable work.
  Applied sessions stay `issued` for current public/preview projection and
  expose safe replacement administration status `applied` with no refresh grant.
- Worker lifecycle dispatch recognizes pending replacements. Admin replacements
  await review; super-admin replacements require captured immutable session
  authority plus the current automatic proposal. Signed-preview failure defers
  application; the existing bounded sweep now also claims/retries automatic
  replacement previews, including after a process interruption. Automatic
  application never republishes an unpublished Video. Own super-admin metadata
  edits during automatic replacement apply directly and update the proposal's
  content too, preventing cutover from reverting those edits.
- Replacement upload cancellation and terminal recovery accept in-review
  bindings, retain public media and reset remaining proposal metadata to draft.
  Removing its media cannot leave an already-submitted metadata-only proposal
  eligible for approval. Whole pending-change cancellation still requires the
  documented upload cancellation step; seven-day rejected-asset grace and
  one-call whole-proposal cleanup remain V5.12.
- Local verification: **8 new tests; full Videos suite 349/349**. Tests exercise
  real application/repository interfaces with fake persistence/provider adapters,
  simulated rollback, readiness/author/session checks, rejection/resubmission,
  unpublish races, durable cleanup failures, Redis-down handling, automatic
  authority, pending preview retry and metadata synchronization. A read-only
  independent safety review found no additional concrete generation/authority
  defect. Its metadata-isolation concern was resolved against Q131: immediate
  super-admin metadata updates are intentional; Q129's atomic review unit
  governs admin proposals. Syntax checks cover changed source/tests/worker.
  Real Mongo transactions/indexes, standalone
  worker restart, Bunny deletion and Flutter playback are not established by
  these tests. Production upload/public gates remain off; no secrets/config,
  live systems, deployment, commit or push changed.
- Next: V5.12 rejected-asset grace and whole-proposal cancellation, then V5.11
  custom covers and the remaining editorial controls. Local V5.10 completion
  does not complete the Videos module or its live acceptance gates.

## V5.10.2.1 Pending Reel replacement uploads (2026-09-30)

- Reused the initial Reel upload/session pipeline with an immutable session
  purpose and previous-asset binding. Replacement reservation attaches to one
  draft/rejected pending proposal, preserving its metadata and the current
  approved/published/unpublished asset. Competing authors, review-locked
  proposals, stale generations and cross-purpose idempotency reuse fail closed.
  Super-admin automatic-application authority is recorded on the reservation;
  its actual cutover is not implemented yet.
- Added protected replacement creation/status and exact-session refresh/cancel
  routes. New creation retains the upload flag and hard-off pipeline guard;
  recovery remains available when gates close. Admins manage their own
  replacement sessions; super admins may manage any. Responses are no-store.
  Refresh reuses the original TUS resource and deadlines, not a new resource.
- Protected preview accepts `asset=active|pending`, defaults to active and
  binds pending media to its issued replacement, immutable ownership/library,
  author and previous generation. Signed playback is probed and the selected
  generation is freshly rechecked before returning the short-lived URL.
- Cancellation/setup failure/confirmed provider absence detach only replacement
  pointers, retain proposal metadata and active public media, and persist
  cleanup before enqueueing. Redis failure leaves recoverable Mongo work.
  Compensation now refuses an unbound returned GUID that aliases an already
  referenced Reel asset, preventing accidental deletion of active/pending media.
- Metadata edits preserve replacement pointers. Metadata-only cancellation
  refuses proposals containing an upload/asset; the replacement cancellation
  route must clean them first. Submit/approve refuse those proposals with
  `VIDEO_REPLACEMENT_REVIEW_UNAVAILABLE` until V5.10.2.2 supplies the cutover.
  No replacement is applied automatically by this slice.
- Verification: **11 new tests; full Videos suite 341/341** using fake
  persistence/provider adapters and local HTTP. Tests cover reservation/replay,
  author/purpose/generation guards, public isolation, refresh, recovery,
  cancellation, durable cleanup, Redis-down behavior, referenced-asset
  compensation protection and pending-preview races. A read-only safety review
  identified the compensation guard, now covered by a regression test.
  Real Mongo transactions, worker/provider cleanup and device playback remain
  unverified. No environment/flag changes, live calls, deployment, commit or push.
- Next: V5.10.2.2 preview-gated review and atomic cutover, automatic super-admin
  application and durable old-asset cleanup. Custom covers and rejected-asset
  grace remain separate incomplete tasks; the complete V5.10 package stays open.

## V5.10.1 Reel metadata editing (2026-09-30)

- Reused the editorial edit/review path for Reel titles/descriptions rather
  than introducing a second workflow. PATCH dispatches to the internal
  `editVideo` interface for either editorial kind; YouTube HTTP behavior and
  verification remain intact. Reel patches reject all media/cover/product,
  publication and kind fields, and preserve the asset/session and recorded
  automatic-publication authority.
- Admin changes to approved/published/unpublished Reels stay in one isolated
  proposal. Submit and approval freshly verify the existing active asset's
  protected preview. Reject/revise/resubmit/cancel keep current public media
  unchanged; approval after unpublish never republishes. Existing author,
  role/control and revision guards remain. Admin edits to a super-admin
  auto-publishing draft are denied to prevent inheritance of that bypass.
- Pending content has an internal kind tag for conditional media validation.
  Existing YouTube proposals default to YouTube and keep their required ID;
  Reel proposals require metadata but reject YouTube media. Public DTOs
  continue projecting only current approved metadata.
- Verification: **10 new tests; full Videos suite 330/330**. Evidence in
  `editorialReelDraft.test.js`, `editorialVideoHttp.test.js`, and the unchanged
  YouTube/public regression tests. Checks cover public isolation, real role
  and control middleware, draft/direct edits, review/rejection/cancellation,
  preview failure, legacy schema validation and concurrent unpublish.
  Persistence/provider and HTTP identity are fake; real Mongo update/validation
  and CDN acceptance remain pending. No live calls, configuration/flag changes,
  deploy, commit or push. V5.10.1 is checked, not the complete V5.10 package.
- Next: V5.10.2 reviewed Reel asset replacement, followed by custom covers and
  the seven-day rejected-asset grace/cleanup flow. These are not included in
  metadata-only cancellation, which has no replacement asset to remove.

## V5.09.1 Reel upload administration (2026-09-30)

- Added protected current-upload status, generation-specific authorization
  refresh, and terminal initial-upload cancellation to editorial routes.
  Creation/replay includes the session ID needed to recover after a UI reload.
  Existing `VIDEOS` middleware remains; admins manage their own Reel uploads
  and super admins may manage any Reel.
- Status reports technical readiness separately from publication and excludes
  provider identifiers/credentials. Refresh reuses the current issued TUS
  resource, bounded by six hours, original resource expiry and the original
  24-hour deadline. Expired resources fail closed with
  `VIDEO_UPLOAD_RESOURCE_EXPIRED`; no replacement resource is created.
- Cancellation reuses the existing transactional recovery path and durable
  provider operations. It targets one generation, refuses ready/published
  media, preserves failed-session markers for late-GUID compensation, and
  remains idempotent without touching a newer upload. Redis enqueue happens
  after commit; enqueue failure leaves sweepable Mongo work. Recovery routes
  stay available when new-upload gates close and use no-store responses.
  Issued-session replay also now checks the exact current draft generation
  before returning credentials.
- Local verification: **11 new tests; full Videos suite 320/320**. Tests cover
  actor/control checks, immutable ownership/library/session queries, safe
  status, resource expiry/abandonment, stale/ready/published cancellation,
  late-GUID eligibility, durable-cleanup failures and Redis-down handling.
  Tests use fake persistence/provider adapters and local HTTP. Real Mongo
  transaction rollback, provider cleanup and the complete upload lifetime
  remain unverified. V5.09.1 is checked; V5.09.2 and live gates are not.
  No environment/flag changes, live writes, package changes, deploy, commit
  or push were performed. Next local feature: V5.10 Reel metadata/replacement.

## V3.13 protected Product Video previews (2026-09-30)

- Added product-nested staff preview at `GET
  /api/v1/products/:productId/videos/:videoId/preview?asset=active|pending`.
  Selection defaults to active; pending is bound to the placement's exact
  issued replacement. Existing super-admin/admin-with-PRODUCTS middleware is
  reused; moderators and regular users gain no additional permissions.
- Previews do not consult upload or public flags and permit inactive products.
  Fresh repository reads require an existing product, current attached slot,
  configured library, typed asset ownership and verified ready media. The
  application probes signed HLS then rechecks generation before returning only
  `{ url, expiresAt }`, with a maximum 15-minute lifetime and no-store headers.
  Active media survives pending/rejected deletion until provider acceptance;
  superseded/cancelled pending assets never receive a new grant.
- Verification: **13 new preview tests passed; full Videos suite 309/309**.
  Tests cover current/pending selection, product/library/owner constraints,
  role/control middlewares, invalid metadata, absent playlist and probe races.
  Syntax checks and diff checks passed. Database/provider adapters and HTTP
  authentication identity are faked; live Mongo/HLS/device acceptance is still
  pending. No live writes, configuration/flag changes, deploy, commit or push.
  `VIDEOS_TODO.md` marks implementation V3.13 complete, not its live gates.

## V4 product-detail media checkpoint (2026-09-30)

- Product detail adds a derived `media` array after the base product DTO is
  read from cache. Its image entries preserve the legacy image descriptors
  and array order; current playable Product Videos follow in their reserved
  selection order, with contiguous response positions. Product cards, lists,
  and search suggestions remain image-only. Gallery projection ignores
  `showInReelsFeed`, which controls only feed projection.
- `PRODUCT_VIDEOS_PUBLIC_ENABLED=false` produces image-only `media` without
  querying Product Video placements. With the flag enabled, fresh placement
  and active-asset eligibility is resolved outside the shared product cache;
  responses contain playback hrefs rather than signed URLs or provider IDs.
  `posterUrl` uses the copied public poster when available and is otherwise
  `null`; the local cover pipeline is described below.
- Public product detail checks current product visibility before loading
  cached data. Inactive or deleted products return `404`; authorized product
  staff retain inactive-product access. Zero stock does not hide media.
  Detail responses are `private, no-store`.
- Corrected two earlier local defects: `videoNextPosition` belongs to the
  root Product schema, where upload reservations increment it; and pending
  explicit deletion must remain visible/playable while its current asset is
  ready. Gallery, feed, and playback now stop exposing that asset when Bunny
  acceptance is recorded (or confirmed absence removes it), preserving Q93
  and Q98 if a delete is rejected or still retrying.
- Verification uses fake database adapters and the product HTTP route.
  No live Mongo transaction/aggregation, Bunny deletion, cover upload, or
  mobile gallery has been verified. All four Videos switches remain off.

## V4/V6 default video posters checkpoint (2026-09-30)

- Added a worker-only poster-copy application and image-store adapter under
  `src/domains/videos/provider`. They copy the provider-selected thumbnail
  through the existing public Bunny image uploader into one deterministic
  WebP key per immutable Video Asset: `petyard/video-posters/<assetId>.webp`.
  Retrying a lost PUT/DB acknowledgment does not allocate another object.
  This implements default provider covers, not optional custom-cover uploads
  or reviewed cover changes.
- The worker sweep finds ready, non-deleting assets without a copied or
  scheduled poster, limited to the configured Stream library. It records a
  durable `copy_poster` operation before marking the asset requested. The
  existing Mongo-backed leases, retry/backoff, BullMQ operation-ID jobs and
  lost-enqueue sweeper execute copies. No provider call runs in a transaction.
  Failed copies do not change technical readiness or publishability: clients
  receive a nullable cover while the durable obligation retries.
- Thumbnail URLs are built only from the configured Stream CDN, checked GUID
  and checked raster filename. A short signed video-directory token is used;
  library API credentials never reach the CDN. Redirects are rejected and
  streamed bytes are capped at 5 MiB. Response MIME, decoded raster format,
  single-frame input and a 16-megapixel bound are checked before storage.
  The Stream request timeout now remains active during body consumption.
  Provider thumbnail layout and CDN protection follow Bunny's
  [native playback URL documentation](https://bunny.net/blog/native-video-playback-with-bunny-stream-and-expo/)
  and [Stream security documentation](https://github.com/BunnyWay/documentation/blob/main/stream/security.mdx).
- Poster attachment rechecks immutable provider identity and current asset
  state after downloading and uses a conditional Mongo update after the PUT.
  A deletion racing the copy prevents attachment and compensates the unused
  object. A pending/rejected Stream delete preserves any attached public
  poster. Only accepted deletion/confirmed provider absence allows normal
  attached-cover cleanup. Cleanup derives the deterministic key even when
  the descriptor never persisted; it uses strict Bunny deletion, not the
  existing best-effort image-delete wrapper that swallows failures.
- Stream acceptance removes the video from public projections immediately.
  If cover deletion fails, the same provider-delete obligation remains due
  with `VIDEO_POSTER_CLEANUP_FAILED` until cleanup succeeds. Stale poster
  completions/failures record a fresh, deduped compensation check rather
  than treating an expired lease update as acknowledged cleanup.
- Gallery `posterUrl` and Reel/Product feed/detail/save `coverUrl` expose
  only the copied stable URL, never its storage descriptor, signed thumbnail
  URL or provider identity. Existing image order, nullable fallback, saves
  rules and independent public flags remain unchanged. No new environment
  variables are required; this uses the existing public-image Bunny config.
- Verification: **296 Videos tests passed** with
  `node --test --experimental-test-isolation=none`; poster tests include the
  actual Sharp/image-upload pipeline with fake storage transport, ownership,
  malformed/oversized thumbnails, body timeout, lost enqueueing, conditional
  attachment, pending deletion, cleanup rejection and stale-lease recovery.
  Syntax checks and `git diff --check` passed. Existing UI Builder, product
  and `.env` work is preserved; no live provider/database/Redis writes,
  deploy, commit, push, package installation or flag changes were made.
- Still unverified: real Mongo indexes/CAS and cross-worker leases, signed
  thumbnail retrieval and image-storage PUT/DELETE, process death during a
  PUT, suspended workers returning after lease expiry, CDN cached-object
  behavior after deletion, and Android/iOS poster rendering. These remain
  explicit rollout/canary gates, not claims established by fake adapters.
  Next safe local slices are custom covers/reviewed editorial changes and
  the remaining administration controls; guarded integration and mobile
  canaries follow before any public enablement.

## V6 public YouTube and saves checkpoint (2026-09-28)

- Added default-off public `GET /api/v1/videos/youtube` and `GET
  /api/v1/videos/:id` for published YouTube Videos only. Responses derive the
  canonical embed URL and localized approved content, without pending review
  data or provider credentials. Positioned entries precede unpositioned entries;
  the latter sort newest-published-first.
- Added separate, deduplicated `VideoSave` records keyed by typed account or
  guest identity. `GET /api/v1/videos/saved` and idempotent `PUT`/`DELETE
  /api/v1/videos/saved/:videoId` use the existing bearer-or-`x-guest-id`
  middleware. No guest/account merge is performed. Hidden saves stay stored
  but do not count toward visible saved-list pagination.
- The original checkpoint was YouTube-only. Reel DTOs, saves, feed routes,
  Product Video projections, and mobile behavior were not present then. The
  public flag remains false. The normal isolated Node test runner could not
  spawn in this Windows environment (`EPERM`); focused files were imported
  in-process instead.
- A later local slice added `GET /api/v1/videos/:id/playback` for an eligible
  published Reel. It rechecks the current issued session and verified ready
  asset, signs a 15-minute-or-shorter HLS grant without exposing provider IDs,
  and rechecks the same asset/session and public switch before returning a
  `private, no-store` response. The route remains behind
  `VIDEOS_PUBLIC_ENABLED=false`. Live mobile playback remains unverified.
- A subsequent local slice added published Reel detail, Reel saves, and the
  `/api/v1/videos/feed` (default `kind=reel`). Listing, detail, and
  saved pagination exclude Reels without the current issued session and
  verified ready, owned asset. DTOs expose only localized editorial content,
  public playback href, dimensions, duration, and `canSave`/`isSaved`; provider
  identifiers remain private. Product Video Feed Entries now project from the
  current ready placement and active product, using the live localized product
  title; they cannot be saved. `kind=product` is newest-active-asset-ready-first.
  `kind=all` applies one newest-first pagination across independently enabled
  types, ignoring manual Reel position, using Reel `publishedAt` and the
  Product Video active asset's `readyAt` as the current attachment timestamp.
  A public Product Video playback route rechecks the active product, placement,
  and asset before and after signing, and remains playable when
  `showInReelsFeed=false`. Both Reel and Product Video `coverUrl` are `null`
  when a copied public poster is unavailable (the default copy pipeline is
  now local; see the V4/V6 poster checkpoint above). Public list,
  detail, and saved responses are `private, no-store` because `isSaved` is
  identity-specific. These are
  backend fake-database tests only; live Mongo aggregation, Bunny playback,
  cover delivery, and mobile behavior remain unverified. Do not enable the
  public flags yet.

## V5 YouTube editorial checkpoint (2026-09-28)

- Added a YouTube-only editorial `Video` model and a revision-checked MongoDB
  repository. Protected `/api/v1/videos/admin` routes now support create,
  list/detail, edit, submit, approve, reject, publish, unpublish, and canceling
  one Pending Video Change. Admin changes to approved/published/unpublished
  content remain isolated until super-admin approval. Approval after unpublish
  cannot republish the Video. Super-admin-authored YouTube Videos publish after
  verification; an admin-authored new Video requires separate approval and
  Publish actions.
- Supported `watch`, `youtu.be`, and `shorts` HTTPS links are reduced to the
  canonical YouTube ID. The server checks that ID through the official YouTube
  Data API `videos.list` resource before creation, submission, approval, or
  publication. Private, non-embeddable, unprocessed, live, and missing videos
  fail closed. Google notes that a video marked embeddable can still fail in
  an embedded player because of platform policies or claims; V6 playback
  therefore still needs safe player-error handling and staff alerting.
- Production verification requires a server-side `YOUTUBE_DATA_API_KEY` with
  the YouTube Data API v3 enabled in its Google Cloud project. The key is now
  encrypted in the local `.env`; without it, write actions return a safe `503`
  and cannot publish. Never send it to Flutter or include it in URLs/logs.
  Google permits `X-Goog-Api-Key` as a request header.
- A super admin can now set or clear the `position` of one published YouTube
  Video through `PATCH /api/v1/videos/admin/:id/position`. It is one
  revision-checked write and does not require multi-document transactions.
  Explicit positions sort first; clearing one restores newest-first fallback.
- The editorial `Video` model now accepts a separate Reel metadata draft with
  bilingual titles, no YouTube ID, and no Product Video linkage. Admins and
  super admins may create the draft through the protected Videos route.
  Submission, approval, and publication require an attached ready asset and a
  signed HLS playlist probe; unavailable playback fails closed.
- A separate Reel upload-session reservation and direct Bunny TUS handoff now
  exist locally with an idempotency key, Reel-owned Video Asset, 24-hour
  abandonment deadline, and durable cleanup intent on setup failure. The
  production route remains hard-off in addition to `REEL_UPLOADS_ENABLED=false`.
  The provider worker now dispatches verified assets by typed owner. A Reel
  callback requires the exact currently attached asset and an issued session;
  it records super-admin auto-publication authority at draft creation and uses
  a revision-incrementing conditional update after a preview-readiness check.
  A local protected staff preview grant at
  `GET /api/v1/videos/admin/:id/preview` now rechecks the current ready Reel
  asset and issued session, fetches a short-lived signed Bunny HLS playlist,
  and returns a no-store `{ url, expiresAt }` response only to staff with
  `VIDEOS` access. The same probe gates Reel submit/approve/publish and
  super-admin automatic publication. A durable five-minute retry marker lets
  the worker revisit already-ready but preview-pending Reels, with a
  conditional claim to limit duplicate probes. These are local fake-provider
  tests only: no live CDN playlist, MongoDB transaction/index, or real upload
  has been verified. Stuck-reservation recovery and terminal upload cleanup
  were added locally on 2026-09-28, but are not live-verified and the upload
  gate must remain closed. The playlist URL shape and path-token behavior follow Bunny's
  [native playback guide](https://bunny.net/blog/native-video-playback-with-bunny-stream-and-expo/)
  and [Token Authentication V2 explanation](https://bunny.net/blog/were-bringing-token-authentication-to-the-next-level/).
- Reel recovery now sweeps `reserving` sessions older than one hour, conditionally
  detaches the still-current draft, and creates a durable Bunny cleanup operation
  when the provider GUID was persisted. A verified terminal transcode/duration
  failure likewise detaches only the still-current Reel and queues cleanup.
  Once the original issued 24-hour window has elapsed, a management-API 404
  can abandon the still-`awaiting_upload` Reel and queue idempotent cleanup.
  It does **not** infer absence or delete a status-0 provider object just
  because its TUS resource expired: `PRODUCT_VIDEO_EXPIRY_RECOVERY.md` records
  why that state is ambiguous. New Reel provider creations carry the unique
  persisted reservation ID in their Bunny title. If a create response arrives
  after the stale-reservation sweep, its GUID is still captured for idempotent
  cleanup without detaching a newer Reel upload. Process death or an uncertain
  response **before the GUID is observed** remains an orphan risk: automatic
  discovery, guarded cleanup, and live validation are still missing. Keep the
  Reel upload gate closed.
  These paths have fake database
  and provider tests, not a live Mongo/Bunny/Redis proof.
- A read-only Reel orphan-discovery module now inspects only failed, untracked
  sessions with a pre-persisted provider title. It performs a bounded Bunny
  library search, requires a complete result page and exactly one exact-title
  match, then re-fetches that GUID. A candidate must have the expected library,
  creation window, zero-byte/status-0 metadata, and no local Video Asset.
  Pagination ambiguity, duplicate matches, mismatched metadata, or a locally
  tracked GUID never authorize cleanup. `no_match_observed` is not proof that
  no video exists. Bunny's
  [Stream client documents list/search](https://github.com/BunnyWay/bunnystream-api-php#methods),
  and one read-only production-library search using a synthetic marker returned
  an empty page with numeric `totalItems: 0`, `currentPage: 1`, and `items: []`.
  This validates the empty-page shape only, not a positive title match.
- The discovery module now has an opt-in `recover` path that repeats inspection
  and conditionally commits a synthetic Reel-owned deleting asset plus durable
  provider cleanup obligation. The Mongo transaction rechecks the failed,
  unclaimed session and exact marker, checks library/GUID ownership, and relies
  on the unique asset index for a concurrent insert. Queueing remains after
  commit and a Redis failure stays sweepable. **The opt-in is false by default
  and no worker or route invokes this path.** No live matching video, Mongo
  transaction, or deletion has been tested; the Reel upload gate remains closed.
- This is not the full V5 package: Reel upload/replacement and approval,
  covers, bulk/drag ordering, admin draft arrangement, and permanent deletion
  remain; public V6 Reel routes/saves are also pending. All four Videos
  switches remain disabled.
- On 2026-09-28, a local read-only `videos.list` check accepted a known public,
  embeddable video using the decrypted key and the production verifier. No
  editorial record was created. This confirms local key/API access, not VPS
  egress, a production write, or a mobile embed. Focused application, HTTP,
  and verifier tests run without MongoDB or Bunny calls. MongoDB
  transaction/index and device checks remain unverified. Source references:
  [videos.list](https://developers.google.com/youtube/v3/docs/videos/list),
  [Video resource](https://developers.google.com/youtube/v3/docs/videos),
  [Google API key header](https://docs.cloud.google.com/apis/docs/system-parameters).

## V1 local checkpoint (2026-09-22)

- Added default-off Stream configuration and startup validation in
  `src/domains/videos/provider/streamConfig.js` and `src/app/server.js`. Complete configuration
  is usable for future protected previews even with public switches off;
  incomplete staged configuration remains inert until a switch is enabled.
- Added the Bunny adapter, now in `src/domains/videos/provider/bunnyStreamAdapter.js`, for management
  create/get/delete, TUS authorization, and CDN Advanced Token Authentication
  path-style HLS signing. It uses no real Bunny calls in tests, keeps keys out
  of returned grants/errors, accepts empty successful deletion responses, and
  bounds upload authorization to six hours and playback grants to 15 minutes.
- Focused configuration/adapter/existing image-config suite: 21/21 passing
  with `node --test --experimental-test-isolation=none` on this Windows host.
  The default isolated `node --test` runner was blocked here by `spawn EPERM`;
  this is a test-runner sandbox limitation, not a failed assertion. Real Bunny
  and mobile playback still require the release canary.
- At the initial V1 checkpoint, no Stream keys were captured and `.env` was not
  changed. Stream settings were subsequently configured in the local encrypted
  environment; all four feature switches remain off.

## V2 local checkpoint (2026-09-23)

- Placed the module under `src/domains/videos` with matching
  `test/domains/videos` tests. Added Video Asset, durable Video Provider
  Operation, and sanitized Video Upload Attempt models and indexes.
- Added atomic operation claims with lease tokens, one-active-operation-per-GUID
  index, idempotent recording, retry/backoff, `needs_attention`, completed
  operation TTL, and queue payloads containing only the operation ID.
- Added a dedicated BullMQ worker, fail-fast producer connection, due-operation
  sweep, and stuck-asset reconciliation. Redis enqueue failures leave MongoDB
  obligations due for recovery. The worker is not a public Videos API.
- Added safe provider-state reconciliation and deletion handling. A 2xx or
  confirmed 404 accepts deletion; 4xx/429/5xx and uncertain responses retain
  the local asset until a later successful delete or absence confirmation.
- Focused V1/V2 suite: 54/54 passing with
  `node --test --experimental-test-isolation=none test/domains/videos/*.test.js`.
  Tests use fake Mongo, queue, and Bunny seams. No live MongoDB/Redis race
  test, Bunny request, application startup, or mobile canary has run. Product
  placements and editorial Videos are not wired yet, so V2 is a foundation,
  not a usable public feature. No feature flag was enabled and no deployment
  or provider upload was performed.

## V3 in-progress checkpoint (2026-09-23)

- Added a Product Video placement and upload-batch model under the Videos
  module. Batch reservation writes the Product document inside a MongoDB
  transaction before counting occupied slots; selection order is stored as
  immutable positions. A positive `activeSlot` marker controls the unique
  product/position index and capacity count.
- Added protected product-nested batch upload-session, status, and TUS
  authorization-refresh routes. The original product/image create and edit
  paths remain unchanged. Upload creation and refresh are blocked by the
  default-off `PRODUCT_VIDEO_UPLOADS_ENABLED` switch.
- The Product Video application validates MP4/MOV metadata and the 250 MiB
  declared-size limit, re-signs an issued batch without creating another Bunny
  resource, and persists compensating cleanup for a failed pre-upload batch.
  Provider reconciliation can advance a still-owned active placement to
  `ready`; stale asset ownership does not advance it.
- Focused Videos suite: 67/67 passing with
  `node --test --experimental-test-isolation=none test/domains/videos/*.test.js`.
  These are isolated/HTTP tests; no live MongoDB transaction, Redis, Bunny,
  upload-resume, or process-crash canary has run.
- **V3 is not complete or safe to enable.** Replacement, terminal failure and
  abandonment, explicit/cascade deletion, provider-expiry fallback, and
  production race/recovery gates remain. A crash between Bunny create success
  and GUID persistence is still an orphan-risk case requiring a recovery rule.
  Keep all four feature flags off and do not deploy this in-progress package.

### V3 continuation (2026-09-24)

- Added terminal-failure compensation: a failed, still-owned upload releases its
  Product Video slot and persists a retryable Bunny cleanup obligation.
- Added explicit ready-video deletion. The placement remains attached in
  `deleting` until Bunny accepts the delete request or its absence is confirmed;
  the worker then removes the placement. Rejected/uncertain deletion keeps it.
- Added cancellation for an unfinished upload at
  `DELETE /api/v1/products/:id/videos/:videoId/upload-session`. It releases the
  slot and records durable provider cleanup. An issued batch with a cancelled
  placement cannot be replayed into new credentials.
- Added ready-video `showInReelsFeed` editing at
  `PATCH /api/v1/products/:id/videos/:videoId`; the payload accepts that
  boolean alone. New-upload shutdown does not prevent existing issued sessions
  from refreshing authorization within their original deadline (Q156).
- Protected Product Video status now reads the durable deletion operation's
  safe failure code, so a rejected Bunny delete can be shown to the editor
  while the video remains attached and public.
- Product deletion now uses the Videos application interface to atomically
  remove the Product, tombstone active Product Videos, and record one durable
  cleanup obligation per attached active/pending Bunny asset. When uploads are
  off and the product has no video placements, deletion retains the existing
  image-only, non-transactional path. The existing image deletion still occurs
  before the Product database write; its separate failure semantics have not
  been changed here.
- The focused Videos suite passes 78/78 and the existing product-image update
  suite passes 3/3 on this Windows host, including fake-database assertions for
  the whole-product cleanup transaction. These do not prove the MongoDB
  transaction, provider race, or cache behavior in production.
  **V3 remains off and incomplete:** replacement/cutover, 24-hour abandonment,
  crash orphan recovery, and live canary gates
  remain. Bunny numeric status alone is not being used as proof an expired TUS
  upload is absent; resolve that with the non-public canary before automatic
  abandonment deletion.

### V3 replacement checkpoint (2026-09-27)

- Implemented protected replacement creation, generation-scoped authorization
  refresh, and cancellation. Replacement creation uses `Idempotency-Key`;
  identical retries reuse the resource, and terminal retries never allocate
  another upload. Refresh/cancellation remain available for issued sessions
  when new uploads are disabled.
- A durable replacement reservation locks the existing placement before Bunny
  creation. It does not consume another slot or change position/visibility.
  Explicit video deletion and visibility edits reject conflicting replacements.
- Verified readiness atomically swaps the active asset and records old-asset
  cleanup. Failure/cancellation retains the old ready asset and records cleanup
  of the new one. Whole-product deletion covers pending assets; a provider
  resource returned after product deletion is compensated, not attached.
- `ProductVideoReplacement` is an operational idempotency/session record, not
  a new editorial entity. Its unique placement/key history has no TTL; worker
  startup creates its indexes. Protected status exposes a safe replacement
  ID/state and failure code, never provider secrets.
- Verification: Videos tests **91/91 passed** using fake HTTP/database/provider
  seams, including rollback on cleanup-record failure and late callbacks.
  Independent read-only replacement safety review found no actionable findings.
  Fake serialized transactions do not establish real MongoDB race safety.
  Syntax checks passed for the ten changed/new JavaScript files and tracked
  `git diff --check` passed. A flags-only dotenvx configuration read did not
  finish and was stopped; encrypted environment values were not modified,
  and their previously verified disabled state was not revalidated this turn.
- **V3 remains disabled and incomplete:** automatic 24-hour abandonment,
  expired-provider-resource fallback, crash/orphan recovery (including provider
  creation before GUID persistence), and live MongoDB/Redis/Bunny canary gates
  remain. No live provider calls, deployment, or feature enablement occurred.
  Finish these recovery gates before proceeding to V4 public media integration.

### V3 expired-session absence recovery (2026-09-27)

- Added a conservative recovery path inside the existing leased reconciliation
  job. After a provider GET returns `404`, the Videos application may retire an
  expired, still-current `awaiting_upload` asset. The original 24-hour deadline
  is rechecked inside the MongoDB transaction; age alone is not sufficient.
- Initial uploads release their placement; pending replacements clear only
  their pending association, preserving the old ready Product Video. Both
  record `VIDEO_UPLOAD_ABANDONED`, a safe audit attempt, and durable cleanup in
  the same transaction. Cleanup still uses the existing BullMQ/Mongo sweep.
- Processing/ready assets, pre-deadline sessions, empty provider responses,
  provider authorization failures, rate limits, timeouts, and server errors
  cannot trigger this abandonment path. Repeated missing-resource observations
  of a resource already under cleanup complete without duplicating cleanup.
- TDD through the approved application/worker interfaces: **104/104 Videos
  tests passed** (13 new recovery cases). Syntax checks passed for all seven
  changed/new JavaScript files, and tracked `git diff --check` passed. The fake
  database tests demonstrate rollback logic, not real MongoDB concurrency.
- Focused independent read-only safety review found no actionable defects in
  the GET-404, deadline, ownership, replacement-preservation, and cleanup path.
- No environment edits, flag changes, startup, deployment, or live Bunny calls.
  Unrelated UI Builder and package-lock changes were preserved.
- **Still incomplete:** this is confirmed-absence recovery, not general
  abandonment of existing Bunny resources. Unknown/in-progress provider state
  remains non-destructive pending a controlled canary. Expired TUS fallback
  before the deadline, stale `reserving` sessions, create-before-GUID crash
  recovery, and real MongoDB/Redis/provider gates remain before V3 enablement.

Provider reference check: [Get Video](https://docs.bunny.net/reference/video_getvideo)
is the resource lookup; [TUS uploads](https://bunny.net/docs/stream/tus-resumable-uploads)
and [webhook status meanings](https://bunny.net/docs/stream/webhooks) do not
establish a tested incomplete-upload deletion predicate for this library.
Do not interpret a numeric webhook status as proof of resource absence.

### V3 unissued-setup recovery; D: workspace continuation (2026-09-27)

- Resumed in `D:\Projects\GitHub\petyard` after inspecting Git changes and
  the Videos/UI Builder checkpoints. Existing shared routing, Product,
  configuration, environment, package/lockfile, and UI Builder work was not
  edited. Changes are confined to Videos code/tests, its worker, and these
  Videos implementation/HTTP documents.
- Added worker-only `recoverUploadSetups()` using the existing periodic sweep.
  It examines at most 100 oldest setup reservations per pass across batches
  and replacements. A one-hour setup grace period is an engineering recovery
  threshold; it does not change the accepted 24-hour issued-upload deadline.
- Only `reserving` records are eligible. Status and age are rechecked inside
  each transaction. Stale batches fail and release their reserved placements
  only with durable cleanup for every known attached asset and safe audit
  attempts. Queue calls remain outside transactions. Failed persistence leaves
  the candidate retryable; one failed candidate does not abort the rest.
- Stale replacement setup clears only its matching reservation marker and
  records `VIDEO_UPLOAD_SETUP_EXPIRED`, retaining the old ready asset. A late
  create response is captured for cleanup without clearing a newer replacement
  or compensating an already-issued/completed session.
- Added the replacement status/update-time index. Existing batch recovery
  indexes are reused. Issued uploads/replacements never enter this setup sweep.
- TDD at the already-approved application interface: **112/112 Videos tests
  passed**, including eight new setup-recovery cases. Syntax checks passed for
  all eight changed/new JavaScript files; tracked `git diff --check` passed.
  Fake database tests do not prove real MongoDB transaction/concurrency behavior.
- Focused independent read-only safety review found no actionable findings in
  setup recovery, issued-session protection, or late replacement compensation.
- No environment/flag changes, provider requests, full application startup,
  deployment, commit, or push. The worker was wired but not started.
- **Remaining V3 gates:** expired-TUS resource fallback, discovery of provider
  resources whose GUID was never persisted and whose create response never
  returns, general abandonment of still-existing provider resources, and live
  MongoDB/Redis/Bunny canaries. Releasing a local setup reservation is not proof
  that an unknown provider orphan was found or deleted. Existing failed records
  retain their identifiers for that later discovery work.

### V3 TUS observation and upload-lifetime guard (2026-09-27)

- Added a read-only Bunny adapter `inspectTusUpload` operation: HEAD with fresh
  scoped upload authorization, exact HTTPS Bunny TUS resource URL policy, no
  API key, and redirects rejected. Successful responses require valid protocol
  headers/byte counts. Results are `incomplete`, `complete` (bytes only, not
  playable readiness), or `not_found`. Errors remain sanitized.
- The adapter's management requests also reject redirects so credentials cannot
  follow a provider redirect to another destination. Existing fixed endpoints
  and return contracts are unchanged.
- This method has no production route/caller and authorizes no deletion. TUS
  HEAD 404 is not a management video GET 404 and cannot establish ownership of
  a client-supplied URL. The accepted path format is deliberately restrictive
  and has not yet been verified against a real Location response.
- Fixed issued batch replay: re-signing now respects the original `abandonAt`,
  caps grants at six hours or the remaining window, and rejects expired,
  processing, ready, failed, or deleting assets. Previously replay could
  generate another six-hour grant beyond the original 24-hour window.
- TDD at the approved adapter/application interfaces: **123/123 Videos tests
  passed** (seven new adapter tests and four upload-lifetime tests). Six changed
  JavaScript files passed syntax checks; tracked `git diff --check` passed.
  Independent security/regression review found no actionable findings.
- Added `BUNNY_TUS_RECOVERY_CANARY.md`, with bounded two-resource scope,
  credential redaction, exact-ID cleanup, and URL ownership/expiry assertions.
  It is a plan, not a run result. Next external step needs explicit approval
  to create and delete disposable resources in the configured Bunny library.
- **Expired-TUS fallback remains unwired** pending the required provider
  evidence and persisted URL-ownership design. Never treat this diagnostic
  prerequisite as completed Q142. Other V3 orphan-discovery/live-test gates
  remain. No environment/flag/shared-file changes or live provider requests.

### V3 first approved Bunny canary attempt (2026-09-27)

- Ran the explicitly approved two-video canary in library `754739` without
  starting the app/workers or changing flags. All four flags were verified
  false; encrypted `.env` remained byte-for-byte unchanged.
- Created exactly two disposable video objects. A's empty TUS POST returned
  201 with a root-relative `/tusupload/<32-character ID>` Location. The local
  harness expected an absolute URL and stopped at its safety gate before
  HEAD/expiry tests; B's TUS resource was not created.
- Deleted both captured video GUIDs: DELETE 200 and subsequent management
  GET 404 for each. No media bytes uploaded. Separate TUS-resource absence
  was not observed. Full evidence is in `BUNNY_TUS_RECOVERY_CANARY.md`.
- Next: safely normalize provider-returned relative Location in the isolated
  harness while retaining the adapter's strict same-origin absolute-URL
  policy. A new two-resource attempt needs renewed approval; do not silently
  exceed the completed run's two-resource scope or overwrite its manifest.
- Ownership/expiry behavior is still unverified. Q142 fallback remains unwired.
  No runtime source or unrelated conversation changes were modified this turn.

### V3 approved Bunny empty-resource canary retry (2026-09-27)

- User approved a further two-resource run. Fixed root-relative Location
  normalization only in the ignored operational harness; 14 local URL checks
  and syntax checks passed. Production adapter policy remains unchanged.
- Both TUS resources created successfully. After A's original two-minute
  authorization deadline, a fresh signature returned TUS 404 while its
  management video still existed (status 0). B remained accessible before its
  own deadline. A never-allocated URL of the observed ID shape also returned
  404, confirming that absence alone is not expiry/ownership evidence.
- **Ownership gate failed:** A's URL signed for B was accepted as incomplete.
  Both had identical progress, so this does not establish provider lookup
  internals; it is enough to reject HEAD as proof of URL-to-video ownership.
  Recovery must use a trusted backend-created/persisted Location bound to the
  exact asset/session generation, with durable setup/crash compensation.
- Cleanup: both exact video DELETEs returned 200 and management GETs returned
  404. No bytes uploaded. Four flags stayed false; `.env` unchanged. First-run
  evidence was preserved. See `BUNNY_TUS_RECOVERY_CANARY.md` for full results.
- Next safe local work: design and implement trusted TUS resource creation,
  persistence, idempotent recovery, and orphan cleanup at the existing module
  seams. Do not infer that completed uploads or in-flight PATCH are safe to
  abandon: those still require a separately approved bounded media canary.
  Q142 automatic fallback remains unwired. No new external run is authorized.

### V3 trusted server-created TUS resources (2026-09-27)

- Implemented `createTusUpload` on the Bunny adapter: signed empty POST with
  bounded file metadata, no management API key, no redirects or automatic
  retry, strict 201/Location handling, and fixed-origin normalization for the
  root-relative Location observed in the canary.
- Batch and replacement setup persist the known Bunny GUID before TUS POST.
  The validated TUS URL and original Unix-second expiry are saved on that exact
  Video Asset before session issuance. Client URLs are never accepted as
  ownership evidence. No signatures are stored.
- Replacement setup now has a durable pre-TUS attachment stage. Setup failure
  and stale-setup recovery can clean that known pending asset, while retaining
  the old ready video and avoiding newer replacement generations. Whole-product
  deletion can discover it even while the TUS POST is in flight.
- Refresh and idempotent replay return the same persisted URL; they allocate
  nothing and cap authorization at the original resource expiry, the 24-hour
  abandonment deadline, and six hours. Expired or legacy-unbound resources
  fail closed with 409, without automatically deleting/replacing media.
- Independent review exposed a status-0 reconciliation interaction: the empty
  canary returned status 0 before bytes, so it must not alone force processing.
  Status 0 now preserves awaiting_upload only; an atomic state filter prevents
  a late status-0 observation from regressing processing/ready/deleted media.
  A red/green recovery regression plus late-observation coverage verifies this.
- The FE contract now requires HEAD/PATCH to `upload.uploadUrl`, never a second
  POST to the legacy informational endpoint. See `VIDEOS_API_CONTRACT_PLAN.md`.
- Verification: **135/135 Videos tests passed** with fake provider/database
  adapters, including the HTTP route suite. Seven changed runtime JavaScript
  files passed `node --check`; tracked `git diff --check` passed. The initial
  Node test subprocess launch was sandbox-blocked; the full suite ran with
  approved local subprocess access, without loading secrets. Independent
  focused security/concurrency review found the status-0 issue above and
  verified its fix with no further actionable findings. No live Mongo or
  Redis behavior is claimed from these isolated tests.
- This is the trusted-resource foundation, **not completed Q142 fallback**.
  In-flight/completed media canary, generation-safe automatic replacement,
  unknown-GUID orphan discovery, and live Mongo/Redis transaction/index checks
  remain. Do not infer deletion eligibility from HEAD 404 or status 0.
- No live provider requests, environment changes, flag changes, app/worker
  startup, or unrelated/shared-file modifications were made in this slice.

### TUS media gate (2026-09-28)

- Current Bunny TUS documentation requires both `filetype` and `title` in
  upload metadata. Corrected the server-created TUS POST to include a bounded,
  server-generated title (not a customer filename). Fake-HTTP adapter tests
  failed before the fix and now pass 19/19; Product Video application and
  replacement tests pass 14/14 each. Runtime JS syntax and tracked diff
  whitespace checks pass. The earlier full 135/135 run preceded this narrow
  metadata fix; no new full-suite result is claimed here.
- The user approved generating and using a synthetic two-second MP4 for the
  bounded two-video media canary. A completed upload reached Bunny status 4
  and remained a complete TUS resource after its initial expiry. B's final
  PATCH locally crossed that expiry and returned 204/full offset, but fresh
  HEAD then returned 404 while its video object still reported status 0.
  The eventual processing result for B was not observed before exact-GUID
  cleanup. Both canary video DELETE requests succeeded and management GET
  confirmed 404; four flags and `.env` stayed unchanged. See
  `BUNNY_TUS_MEDIA_CANARY_PLAN.md` and its private ignored manifest for times,
  IDs, and limitations. **Q142 automatic fallback remains unwired**; the
  canary does not justify deletion from a TUS 404 or early status 0.
- The conservative Q142 decision matrix and future generation-scoped adoption
  seam are recorded in `PRODUCT_VIDEO_EXPIRY_RECOVERY.md`. Status 0 plus an
  expired TUS 404 remains ambiguous even after a successful final PATCH, so
  that path must retain its current Video Asset and slot while management
  reconciliation continues. This is a design checkpoint, not an implemented
  automatic fallback.
- A focused red/green Product Video application-interface slice makes
  authorization refresh of an otherwise-current but originally expired TUS
  resource return `409 VIDEO_UPLOAD_RESOURCE_EXPIRED`. It neither allocates
  nor deletes provider media, and applies to Product Video and pending
  replacement refresh. The API contract documents the new safe code and
  explicitly forbids client-side fallback creation. Focused Product Video
  and replacement tests passed 18/18; adjacent application/lifetime tests
  passed 19/19. Syntax and tracked diff checks passed. No new Bunny request,
  flag change, app/worker startup, deployment, commit, or push occurred in
  this local slice. Q142 automatic fallback is still pending provider evidence
  and generation-race implementation.
- The separately approved one-video late-processing follow-up returned HTTP
  408 at the TUS expiry before its delayed final bytes, so it did not resolve
  B's eventual processing state. Its one exact GUID was deleted (HTTP 200)
  and management GET confirmed 404 both immediately and after the delayed
  callback. The ignored harness was corrected to cancel pending writes on
  early responses, without a rerun. Evidence is in
  `BUNNY_TUS_MEDIA_CANARY_PLAN.md`; Q142 remains unwired and no further Bunny
  allocation is authorized by that consumed approval.
- Local Product Video generation-race regressions now cover both orderings of
  a stale provider 404 versus a verified-ready snapshot and a late-ready
  pending replacement after abandonment. At the approved application seam,
  readiness preserves the current slot against a paused old 404; committed
  abandonment cannot be revived by a late ready observation; and an
  abandoned replacement cannot displace the old ready Product Video.
  `productVideoAbandonment.test.js` passed 16/16 with fake provider/database
  adapters. The existing guards needed no production change. These tests do
  not prove live Mongo transaction isolation or resolve status 0 plus TUS 404.

## Persistence draft

These are implementation fields to validate during V2/V3, not additional
product decisions:

- `Video`: `kind` (`youtube|reel`), bilingual title/optional description,
  publication state, author/reviewer, active asset or YouTube ID, current
  cover, ordering position, publication timestamps, and at most one Pending
  Video Change with its own safe review reason and optional replacement asset.
- `VideoAsset`: exactly one typed owner (`reel|product_video`) and owner ID,
  unique provider library/GUID pair, technical state, verified duration and
  dimensions, poster, timestamps, and safe failure code. No reusable playback
  or upload credential is stored.
- `ProductVideo`: product ID, immutable reserved position, feed-visibility flag,
  active asset, at most one pending replacement, state, and timestamps. The
  placement ID is the public media/feed/analytics content ID.
- `VideoSave`: exactly one account-user or guest identity plus editorial Video
  ID and saved time; unique per identity/video pair.
- `VideoProviderOperation`: operation type, target asset/provider identity,
  deterministic dedupe key, state, attempt/next-attempt time, lease token and
  expiry, safe last-error code, completion and optional purge time.
- `VideoUploadAttempt`: actor and owner IDs, safe filename, stage/outcome,
  timestamps, and purge time only; never video bytes or credentials.
- Analytics needs raw-event and daily-aggregate collections in addition to
  the six domain collections accepted in Q100; their final field/index shapes
  belong to V8.

Index gates: unique provider identity; unique Product Video product/position;
unique user/video and guest/video saves; due-operation claim and target-GUID
serialization indexes; feed/publication sort indexes. Set TTL `purgeAt` only
on completed operations and expiring audit/events, leaving unresolved cleanup
records without a TTL. Validate index creation and legacy-data migration in a
non-production database before rollout.

Concurrent batch reservations must serialize on the owning Product document
or an equivalent per-product guard inside a MongoDB transaction. Merely
counting Product Video documents and inserting new documents in concurrent
transactions is insufficient to enforce the three-slot limit.

## State and race gates

| State change | Required guard | Public effect |
| --- | --- | --- |
| Product upload reserved → processing → ready | Known placement, current Bunny GUID, provider-verified duration/dimensions/encodes | Add video after all images only at `ready` and only when product/public switch permit |
| Product replacement ready | Replacement still belongs to the current placement and no deletion/tombstone won the race | Atomically switch gallery and product feed to new asset; enqueue old asset cleanup |
| Product terminal upload failure or cancellation | Attempt still current; idempotent cleanup operation persisted | Release reserved slot; never show failed asset |
| Explicit Product Video deletion requested | Durable intent committed; no conflicting replacement/visibility mutation | Keep active public video until Bunny `2xx` or confirmed absence; then remove |
| Whole product deletion | Every provider GUID captured in durable cleanup work before product removal | Product and projections disappear locally without waiting for Bunny |
| New admin-authored editorial Video approved | Asset ready and previewable for Reel; reviewer is super admin | Stay hidden in `approved` until separate Publish |
| Published Video edit approved | Pending change is current and reviewer is super admin | Switch complete approved change atomically; remain unpublished if an unpublish happened during review |
| Public switch disabled | No new public detail/playback grants | Relevant list empty; already issued signed HLS may work for at most token lifetime |

Every transition must be idempotent and reject stale provider events. Tests
must cover concurrent replacement versus explicit delete, whole-product
deletion versus late upload completion, duplicate webhook versus reconciliation,
and admin approval versus unpublish.

## HTTP contract draft for V3–V8

Accepted public paths are in `VIDEOS_API_CONTRACT_PLAN.md`. The following
administration/write path spellings and payload details are engineering drafts
to verify against route conventions before V3/V5 implementation:

| Intent | Proposed method/path | Key request/response facts |
| --- | --- | --- |
| Product batch | `POST /api/v1/products/:productId/videos/upload-sessions` | `Idempotency-Key`; `{ files: [{ clientId, filename, mimeType, sizeBytes, showInReelsFeed }] }`; response pairs each client ID with placement ID, reserved position, status, TUS instructions, expiry |
| Product admin status | `GET /api/v1/products/:productId/videos` | Protected placements including active and pending technical state; never expose provider keys |
| Product replacement | `POST /api/v1/products/:productId/videos/:videoId/replacement-upload-session` | `Idempotency-Key`; old active media remains public until verified cutover |
| Product upload refresh | `POST /api/v1/products/:productId/videos/:videoId/upload-authorization` | Refresh only an existing live session within its 24-hour window; do not allocate another slot |
| Product upload cancellation | `DELETE /api/v1/products/:productId/videos/:videoId/upload-session` | Release an unfinished slot and persist provider cleanup; works while new reservations are disabled |
| Product visibility | `PATCH /api/v1/products/:productId/videos/:videoId` | Only `showInReelsFeed` in MVP |
| Product remove | `DELETE /api/v1/products/:productId/videos/:videoId` | Durable intent, Q96 provider response matrix, public removal only after accepted deletion/confirmed absence |
| Editorial writes | `/api/v1/videos/admin[/:id]` plus explicit action suffixes | `VIDEOS` control for admins; super-admin-only review/publication/deletion/ordering |
| Saves | `GET /api/v1/videos/saved`, `PUT/DELETE /api/v1/videos/saved/:videoId` | Bearer or `x-guest-id`; idempotent; no Product Video saves |
| Analytics | `POST /api/v1/videos/analytics/events` | Bounded event batch; per-event ID, playback-session ID, content type/ID, event type, bounded values |

Use the existing operational error envelope
`{ status, error: [{ code }], message }` for stable Videos error codes. Do not
make mobile/admin clients parse the message. Product/detail/list success
envelopes retain their existing shapes; public feed and Saved Videos use
`{ totalResults, totalPages, page, results, data }`.

## Contract review items before coding

- Fix the exact analytics playback-session issuance and event DTO. HLS grants
  naturally issue a session ID, but YouTube playback has no HLS grant; choose
  one consistent server-issued session interface without weakening Q139.
- The approved empty-resource and synthetic-media canaries have now probed
  Bunny TUS expiry and completion in this library. They did not establish B's
  eventual processing outcome after a PATCH spanning expiry or validate an
  automatic replacement implementation. Q142 remains the required recovery
  rule and must be designed against both the observed 404/status divergence
  and generation races before it can be enabled.
- Specify exact admin preview routes and confirm they remain protected when
  public flags are off.
- Confirm schema indexes and product-level slot serialization against the
  deployment's MongoDB transaction support.
- Verify YouTube WebView callback reliability on both mobile platforms. Do not
  synthesize unavailable watch/progress metrics from a screen-open event.

## Release checklist

Completed editorial/cover/orphan live acceptance, 2026-10-10 (Africa/Cairo): after
the user's `next` on the concrete scope request, unused-scope/flags-off preflight
passed. Actual Bunny/copied-Mongo services, preview, lifecycle, cover store,
orphan sweep and durable runtime passed all three scenarios plus parent:
4 passed, 0 failed/skipped, 159.2 seconds. Admin approval stayed hidden until
Publish; pending media/cover stayed out of public responses until reviewed
cutover; unauthorized preview made no provider call; one denied verifier kept
Ready super-admin media Draft until a successful actual HLS retry. A lost caller
response after actual create was adopted exactly once by competing sweeps and
cleaned despite observed queue-ack loss. No production-code change was needed.
Cleanup verified four management GUIDs, both image origins and twelve marked
collections absent. Three completed TUS records deny fresh PATCH (401/404/404).
Both deleted public cover URLs still return cached CDN 200; origin absence and
cache lifetime remain separate. Manifest confirms 102 requests, zero cleanup
failures and unchanged `.env`. All scopes are consumed. The selected local
backend checkpoint is complete; normal 703/0/5-skip evidence remains valid.
The user has been asked for FINAL.04's admin/Flutter target/content scope.
No handoff document, deployment, flag/guard change or customer mutation occurred.
Other provider permutations retain their component-proof limits; full client,
VPS, staged enablement and release acceptance remain separate.

Editorial/cover/orphan preparation, 2026-10-09: shared actual-service/Mongo/runtime
fixture passed review/separate Publish, public isolation through media+cover
reviewed cutover, automatic publication's preview fence, exclusive exact-marker
orphan sweep adoption and cleanup despite lost queue ack. Simulated-provider
copied-Mongo run: 4/4 including parent, 57.2 seconds; eighteen owned collections
removed. Fixture-only `kind: reel` input corrected; review's unauthorized-preview
assertion added, then strengthened run passed. Normal suite: 703 passed, 0 failed,
5 external skips, 22.0 seconds. No production code change. Prepared bounded live
scope: four Stream videos, two fresh cover objects, twelve marked collections,
180 work/50 cleanup requests, exact owned targets and fixed one-run manifest.
No-network preflight and source review passed; live execution requires a new
explicit approval. It will verify origin absence and observe CDN cache behavior
separately. Frontend handoff and release remain deferred.

Live replacement-race acceptance, 2026-10-09: the user approved the prepared
four-video/twelve-collection scope with `go`. The actual Bunny adapter and
copied-Mongo services/runtime passed Product cascade deletion versus delayed
replacement Ready, and Reel cancellation versus delayed replacement Ready,
preserving published current media. Both cases and the parent passed (3/3,
145.5 seconds). Cleanup verified all four exact management GUIDs and twelve
marked collections absent. Completed TUS metadata is retained but denies fresh
PATCH (401/401/404/404); `.env` unchanged, zero cleanup failures, 95 requests.
No new production defect or code change was needed. The scope is consumed;
no fresh allocations, deployment, guard changes or frontend handoff occurred.
Broader provider-coupled review/cover/orphan, CDN and full-release gates are
still explicitly limited by their existing evidence in the acceptance ledger.

Replacement-race preparation, 2026-10-09: the shared fixture passed both Product
cascade deletion and Reel replacement cancellation races against the approved
Mongo copy with a simulated provider (3 tests including the parent, 0 failures,
63.2 seconds; 18 owned collections removed). Corrected a fixture-only Reel file
payload that included Product-only `clientId`. The live runner now prepares a
separate four-video/twelve-collection one-run scope, with exact owned target
guards and a reserved cleanup request budget. No-network preflight and focused
independent source review passed. Normal Videos regression: 703 passed, 0 failed,
5 external skips in 22.5 seconds. New live allocation remains unauthorized until
the user approves this concrete bounded scope. No backend behavior, feature flag,
deployment or frontend handoff changed.

1. Feature implementation and tests pass with all four switches off.
2. Complete encrypted Bunny secret handoff. No secret in Git, logs, browser
   bundles, or Flutter configuration.
3. Configure signed webhook only after the production HTTPS endpoint exists.
4. Complete the remaining Q141 playback/integration checks and Q142/Q157
   replacement-race tests in a controlled scope; the bounded TUS canaries are
   recorded separately and are not full release acceptance.
5. Enable upload switches for a small staff allowlist, then public switches in
   separate steps. Verify rollback turns off new read/grant access without
   corrupting existing media and that in-flight uploads follow Q156.
