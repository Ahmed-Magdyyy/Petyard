# PetYard Videos — session #2 handoff

Current local extension, 2026-10-15: the human explicitly resumed the original
chat for the Videos portion of the new production handoff. Continuation chat
01a11c64-2337-7f23-8cda-8d104c7937ec is completed, not editing concurrently.
The user-reported VPS baseline is 08ac5b9, seven online PM2 processes, seven
signed Bunny callbacks returning 202 and completed test-video absence/cleanup.
The newly approved ordered `productIds` extension (maximum 50) is implemented
locally for general YouTube/Reel only, with active/pending separation and
authoring/publication eligibility. Final combined Videos plus two notification
files: 729 passed, 0 failed, 5 opt-in external skips. Collection and detailed
handoff checkers pass; independent review's Mongoose ObjectId issue is fixed.
See `VIDEOS_PRODUCTION_HANDOFF_RESPONSE.md` for exact evidence and remaining
client/release gates. Other conversation's UI/Product edits are preserved.
No new live calls, .env/flag changes, packages, commits/pushes or deployment were
authorized or performed. This update supersedes old “pause original chat” and
old unfinished-cleanup instructions below, not the existing safety boundaries.

Release preparation, 2026-10-10: the user authorized committing/pushing all
current Videos and Prime/warehouse changes to GitHub and will pull the VPS
personally. Public/upload flags, Reel/cover pipeline readiness and bounded
orphan recovery are enabled in encrypted `.env`; existing settings are unchanged.
Production readiness guards now read explicit fail-closed release switches.
Combined Videos and eight Prime/warehouse test files passed 779 tests, zero
failures, five external opt-in skips. Sandbox loopback failures were resolved
by running the same mocked HTTP suite with permitted loopback access.
See `VIDEOS_GITHUB_RELEASE.md` for server activation and rollback instructions.
No VPS source, environment, process, database or Bunny settings were changed.
This release authorization supersedes the historical deferrals below, but
does not establish deployed webhook, worker, frontend or payment acceptance.

Latest document checkpoint, 2026-10-10: the user supplied FINAL.04's exact scope:
extremely detailed, organized customer/mobile and admin flows, every response
field and its meaning/use, retained request state, retries and edge cases.
`VIDEOS_FRONTEND_HANDOFF.md` is complete and source-reviewed. All 53 mounted
frontend-facing routes are inventoried; Product gallery and staff notification
touchpoints, exact DTOs, TUS/session/recovery, review/Publish/automatic application,
covers/order/deletion, saves/HLS, analytics and provider operations are covered.
The shared Cairo JSON replacer's offsetless timestamps are documented explicitly.
Checks: 53 routes, 92 local links, 21 JSON examples, 105 headings/anchors, zero
missing frontend-domain codes. Actual analytics validation/policy accepted its
11-event example, 17,100 ms watch time, one qualified view. FINAL.04 is checked.
No application code, `.env`, provider resources, flags/guards, commits, pushes or
deployment changed. All prior scopes remain consumed. The next work is actual
customer/admin client implementation and acceptance, then separately authorized
release/deployment/enablement. Historical instructions deferring the document
below are superseded by this explicit user scope and completed artifact.

Latest completed checkpoint, 2026-10-10 (Africa/Cairo): the user instructed
`next` after the concrete four-video/two-cover/twelve-collection request. Fresh
no-network preflight confirmed unused scope and flags off. Actual Bunny plus
approved Mongo copy passed admin review/separate Publish, protected signed HLS
preview, public isolation through reviewed media/cover cutover, preview-fenced
automatic publication and exclusive Reel orphan adoption/cleanup despite one
observed lost queue acknowledgment. All three cases plus parent passed (4/4,
0 failures/skips, 159.2 seconds). No production-code change was needed.
Exact management GET 404 verified four Stream videos absent; authenticated
origin GET 404 verified both cover objects absent; all twelve marked temporary
collections were removed. Three completed TUS records remain readable but
fresh PATCH returns 401/404/404. Both public cover URLs still served CDN 200
after origin deletion; cache eviction was not performed or promised. Private
manifest verification confirmed 102 requests, zero cleanup failures and
unchanged `.env`. `scripts/videos-live-editorial-orphan-20261009/private.json`
is consumed: cleanup only, never fresh allocations. Existing 703/0/5-skip
normal regression remains valid; no code changed afterward.
The selected local backend checkpoint is complete; no known unfinished local
implementation remains in the accepted scope. Broader provider permutations
retain their stated proof limits. VPS release/configuration, guard/flag/orphan
enablement, actual frontend/device acceptance and full release sign-off remain
separate. FINAL.04's then-pending scope clarification was subsequently supplied
by the user and completed in the document checkpoint above. Preserve dirty
user changes and all release gates.

Latest preparation, 2026-10-09: `videoEditorialOrphanAcceptance.js` now exercises
actual admin Reel review/separate Publish, reviewed media/cover cutover and old
cleanup, super-admin preview-gated automatic publication, and lost-create-response
orphan adoption through competing sweeps with one observed lost queue ack.
Copied-Mongo preflight with simulated providers passed 4/4 tests including the
parent in 57.2 seconds; all eighteen marked collections removed. The initial
missing `kind: reel` fixture input was corrected. Review found an unauthorized
preview proof gap; the successful strengthened run verifies 403 without provider
calls and denied-preview Ready media staying Draft before successful retry.
Normal suite passed 703/0 with 5 external skips in 22.0 seconds. Source review
and no-network preflight passed. The shared live runner's
`VIDEOS_LIVE_EDITORIAL_ORPHAN=true` prepares four synthetic videos, two cover
objects and twelve marked collections; 180 work and 50 reserved cleanup calls.
Private manifest: `scripts/videos-live-editorial-orphan-20261009/private.json`.
This preparation's pending approval state is superseded by the completed
2026-10-10 checkpoint above; the scope is consumed. Origin deletion and CDN
cache observations remain separate. Do not create FINAL.04 or change flags,
guards, commits, deployed state or customer records.

Latest live checkpoint, 2026-10-09: the user approved the new four-video scope
with `go`. Actual Bunny/copied-Mongo replacement-race acceptance passed both
cases and the parent (3 passed, 0 failures/skips, 145.5 seconds). Whole-Product
deletion removed current and pending generations despite delayed replacement
Ready; Reel cancellation removed pending media while preserving published
current media/session. Late replay did not revive deleted assets. Exact
management GET 404 verified all four videos absent; all twelve ownership-marked
collections were removed. Completed TUS metadata remains readable but fresh
PATCH returned 401/401/404/404. Manifest verification found both checks passed,
95 total provider requests, zero cleanup failures and unchanged `.env`.
`scripts/videos-live-replacement-races-20261009/private.json` is consumed and may
be used only for cleanup, never fresh allocation. This supersedes the pending
approval paragraph below. Local code did not change after the 703/0/5-skip
regression. Frontend handoff has not been created. Broader provider-coupled
review/cover/orphan proof, CDN cache behavior, client/device and deployment/
enablement gates remain as scoped in `VIDEOS_TODO.md`; do not claim full release.

Latest continuation checkpoint, 2026-10-09: two replacement races passed on the
approved Mongo copy with an in-memory provider: whole-Product cascade deletion
beats a delayed replacement Ready response and deletes both generations; Reel
replacement cancellation beats delayed Ready and preserves published current
media/session. Three tests including the parent passed in 63.2 seconds. All 18
owned temporary collections were removed and absence verified. The initial Reel
fixture incorrectly included Product-only `clientId`; its corrected payload
passed. No production code change was needed. The shared live runner now has
`VIDEOS_LIVE_REPLACEMENT_RACES=true`: four synthetic videos, twelve marked
collections, fixed `scripts/videos-live-replacement-races-20261009/private.json`,
180 work requests and 40 reserved cleanup requests. No-network preflight and
focused source review passed; normal regression passed 703/0 with 5 external
skips in 22.5 seconds. **New live scope awaits explicit approval; do not allocate
until approved.** Existing allowances are consumed. Frontend handoff, commit,
push, deployment and flag enablement remain deferred.

Latest scope clarification, 2026-10-09: finish local-laptop implementation and
acceptance first. No Videos code has been pushed/deployed to the VPS. Local
webhook/worker wiring and all Stream/YouTube credentials were rechecked as
present. Treat the absent VPS code/settings as later release requirements;
do not confuse them with missing local implementation.

Checkpoint: 2026-10-08, workspace `D:\Projects\GitHub\petyard`.
The user requested a safe pause in the original chat and a new chat named
**PetYard - Videos implementation #2**, with implementation continuing there.
The original chat stops after saving this handoff; it must not keep editing.

Continuation checkpoint, 2026-10-08: TUS-aware cleanup, V3.10 status-0
abandonment and V3.11 Product non-resumable recovery are now locally complete.
Equivalent initial/pending Reel non-resumable recovery is also complete locally
under V5.09.2, preserving published media, metadata and review authority.
The recovery checkpoint passed 692/692 Videos tests. The unfinished-slice notes below
describe the original handoff, not current status. Start from `VIDEOS_TODO.md`
and the latest implementation/recovery checkpoints. FINAL.01–03 Videos enum
centralization/verification are locally complete: 27 frozen exports, unchanged
persisted/API values and validation subsets, 692/692 Videos tests and 14/14
selected Product integration tests before/after, source-preservation comparison
and focused independent review. The user's latest instruction defers FINAL.04
until remaining backend implementation and acceptance are complete.
Automatic orphan recovery is now wired default off, the local Videos suite
passes 702 tests, and the authorized copied-Mongo/local-Redis run passed 24
acceptance checks with verified cleanup of 18 temporary collections and queue
keys. See `VIDEOS_BACKEND_ACCEPTANCE.md` for scope and outstanding gates. Live
provider/database coupling, deployed process proof and rollout remain open.

Continuation checkpoint, 2026-10-09 (Africa/Cairo): the user authorized reading
the configured credentials and explicitly approved a three-video/three-image
Google/Bunny acceptance scope. Real YouTube verification, partial TUS resume with
fresh authorization, termination/HEAD absence, Ready/status-5 rejection, signed
HLS/thumbnail and poster/cover storage passed. All provider/image resources were
removed and absence verified; the scope is consumed. The actual standalone
worker entry point also passed isolated startup, SIGKILL/restart redispatch and
SIGTERM shutdown with verified temporary Mongo/Redis cleanup. All flags/guards
remain off. See `VIDEOS_BACKEND_ACCEPTANCE.md` for exact limits. The existing
admin client identifies `api.petyardstores.com`; unauthenticated probes show
that Videos admin and Bunny webhook routes are not exposed there. The user
authorized notifying all devices under super-admin `691abbbbc2b6dc546f3e730f`;
Firebase accepted all nine Android/iOS tokens with zero failures. Read-only
recipient/device lookup used configured Mongo, without database changes. The
user was asked to confirm phone receipt; full Videos alert delivery is not proved.
Read-only VPS checks confirmed the worker/webhook files and Stream/YouTube
environment settings are absent. PM2 has no Videos worker; the server checkout
has an existing `server.js` modification. Preserve it. Local PM2 Videos config
now uses the shared Node interpreter. No deployed state changed. A prepared
ten-video/twelve-collection combined recovery scope is now consumed. After fixture
clock and Reel TUS title corrections, Product initial and Reel replacement
recovery passed. All ten management videos and twelve temporary collections are
absent; seven unfinished TUS resources are absent. Three completed TUS metadata
records remain readable but reject fresh upload signatures after deletion.
The separately approved five-video follow-up passed Product replacement and
Reel initial recovery plus signed local webhook replay/deduplication and actual
provider reconciliation after injected enqueue loss. All five media GUIDs and
twelve temporary collections are absent; four unfinished TUS resources are
absent. One completed metadata record remains readable but PATCH returns 404.
All four recovery paths now have combined acceptance. The approved two-video
media scope is consumed: real 92-second Reel rejection/detachment/durable cleanup
passed; the portrait case stopped at an expired-grant status assumption.
Both management videos and twelve owned collections are absent. Unfinished TUS
HEAD returned 404; completed metadata remains readable but PATCH returned 404.
A deleted-resource diagnostic found HTTP 400 with explicit expiry text; the
test now classifies it safely and counts only successful cases. A new portrait-only
retry was approved and consumed but failed because Bunny says the expiry time
is in the past rather than using the word `expired`. Cleanup verified its video,
unfinished TUS resource and twelve collections absent. The final parser passed
both the focused test and an actual response diagnostic on a deleted owned
resource. The approved second one-video retry is consumed and cleaned up.
Portrait transcoding, live expired-grant rejection/unchanged offset/same-resource
service refresh/resume and HLS 200-before/403-after expiry passed. The deletion
race stopped because the fixture had not applied Ready first. The corrected
fixture now applies Ready before holding the second provider GET and respects
the asset's Ready-with-intent state until deletion acceptance. Forty focused
tests passed. The separately approved deletion-only one-video run passed:
deletion won against the held real Ready response, actual provider cleanup
released the slot, and late replay did not revive the asset. Its management
video and twelve collections are absent; completed TUS metadata remains readable
but PATCH returned 404. `.env` unchanged. All these provider scopes are consumed;
do not allocate from any consumed manifest.
The full local Videos error-alert/outbox/dispatcher pipeline also passed: two
reports, one obligation, one isolated inbox record, nine Firebase acceptances,
zero failures, and five temporary collections removed. The user confirmed
Android phone receipt with a screenshot showing both test notifications.
Final normal Videos regression after all fixture corrections: 703 passed,
0 failed, 5 opt-in external skips (5.6 seconds). The skipped checks have separate
authorized external results; skipping does not itself prove acceptance.
The `.env` database differs from the approved copied database; continue using
only the explicit acceptance URI and isolated collections for database tests.
Earlier authorization restrictions below describe the original handoff and are
superseded only by these specific subsequent approvals. No frontend handoff yet.

## Start here

Focused follow-up acceptance, 2026-10-09: both copied-Mongo failure checks passed
(real commit with injected acknowledgment loss and actual isolated-client
disconnect), with eight owned collections removed. Both focused alert-race/
changed-staff checks passed, with eighteen owned collections removed, no Redis
commands and no notification delivery. Expanded actual worker-process acceptance
also passed (99.5 seconds): SIGKILL during a held simulated provider DELETE,
retained real BullMQ job, owned lease expiration, restart and completed Stream/
poster cleanup, then SIGTERM shutdown and verified Mongo/Redis cleanup.
Provider responses were simulated and no real provider resources allocated.
See `VIDEOS_BACKEND_ACCEPTANCE.md` for the precise proof limits.

1. Confirm the D: workspace and inspect `git status --short`. Preserve all
   existing changes, including untracked files. Another conversation owns
   unrelated Prime Location/UI Builder work. Do not reset, stash, clean,
   overwrite, commit, push, deploy or install anything without authorization.
2. Read this handoff, `VIDEOS_TODO.md`, the current 2026-10-08 sections of
   `PRODUCT_VIDEO_EXPIRY_RECOVERY.md` and `VIDEOS_IMPLEMENTATION_PLAN.md`,
   then the relevant source. Older checkpoints are historical, not current
   authority. Do not re-grill settled product decisions.
3. Finish and review the current cleanup slice before starting abandonment or
   fallback. Its focused tests are green, but it is not marked complete.

## Instructions and authorization

- Automatically use Ponytail **full** from the current skills catalog. Use
  Caveman **lite** for clear, complete English; persistent documents use normal
  prose. Use TDD and the appropriate focused implementation/review skills.
- Preserve PetYard's architecture: routes compose middleware; controllers own
  HTTP; services own business/provider orchestration; validators validate;
  repositories/models own persistence. Product code calls Videos services,
  never Bunny/BullMQ directly. Do not collapse these layers for simplicity.
- Reuse `protect`, `optionalProtect`, `protectUserOrGuest`, role/control checks
  and existing enums in their correct places. No new middleware bypass.
- Approved test seams include Bunny adapter with fake HTTP and provider worker
  with fake database/provider/queue boundaries. Product Video service/HTTP,
  Editorial service/HTTP, public saves/reads and analytics service/HTTP also
  have recorded approvals. Do not invent private test seams or mock internal
  collaborators when real local modules can use fake external adapters.
- Work directly by default. Independent review is justified for destructive
  cleanup/concurrency. Prefer bounded Luna work; use Sol 6.1 when necessary.
  Do not use Astra without the user's specific approval and capability evidence.
- Local implementation is authorized. No live Bunny resources, real database
  writes, Redis/worker startup, flags, environment changes or deployment are
  authorized by this continuation. Old canary approvals are consumed.
- Do not read/decrypt/print `.env` or private signed URLs/manifests. Do not
  write global memories unless directly asked. Use `apply_patch` for edits.
- Do not change the selected main model/effort. Keep chat titles project-prefixed.

## Feature scope already agreed

- One Videos tab: YouTube Videos and a reels-style feed.
- YouTube is link/metadata content with embedded playback. Bunny Stream hosts
  native Reels and Product Videos; no self-built encoding/CDN infrastructure.
- Uploaded videos may be portrait or landscape, maximum 90 seconds. No captions
  required; titles/descriptions are distinct from captions.
- Manual Reel uploads by admins require super-admin approval; super-admin uploads
  follow the agreed auto-publication rules. Published replacements preserve the
  old media until the new media is ready and required review is satisfied.
- Product Videos upload only through product create/edit, with existing product
  editing permissions and no new approval requirement. No independent title or
  description. At most three product slots; failed/abandoned replacement assets
  do not consume active capacity.
- Product response preserves legacy `images`; additive `media` contains existing
  images then videos in selection/upload order. No product drag/reordering.
- Eligible Product Videos automatically project into the reels feed using live
  product titles, controlled by the agreed visibility flag. Product/video removal
  removes their feed entry; they are projections, not copied editorial Reels.
- Saves exist separately for account users and guests; no automatic identity
  merge. Product Video entries cannot be saved and expose the agreed save flag.
  Likes/comments are explicitly out of scope.
- Public/editorial ordering, separate admin draft ordering, covers, pagination,
  playback tokens, analytics and notification rules are detailed in the accepted
  decision/API documents. Reuse them rather than inventing defaults.

## Provider evidence now available

User supplied Augusto's reply in Bunny ticket **#431686**, dated
2026-10-07 21:44:39 (display timezone unspecified):

- Token expiry during final PATCH can return full-byte HTTP 204 without accepting
  processing. Bunny acknowledged a bug and planned a fix, not a deployed fix.
- Management status 0 means no completed upload accepted; Bunny does not
  auto-process/delete it. Our original 24-hour cutoff is a reasonable policy.
- Management progression described as 2 Processing, 3 Transcoding, 4 Finished;
  failures 5 or 6. Existing status-1 handling remains unchanged.
- TUS HEAD 404 means that session cannot resume. Check management state before
  creating a new resource; TUS absence is not management video absence.
- Terminate an in-flight TUS upload before management video DELETE. After
  deletion, management GET 404 establishes provider absence.
- Authorization must cover the whole upload. Do not silently change six-hour
  upload configuration or original resource/24-hour deadlines. "Shortly after"
  a final PATCH is not an exact automatic-deletion timeout.

Official docs checked on 2026-10-08:

- https://bunny.net/docs/stream/tus-resumable-uploads
- https://bunny.net/docs/stream/webhooks
- https://tus.io/protocols/resumable-upload#termination

Webhook status values differ: 6 means pre-signed upload started, 8 upload failed.
Callbacks remain signed reconciliation hints; only matching management GET
snapshots update technical state. TUS protocol termination specifies DELETE
with Tus-Resumable 1.0.0 and successful 204; Bunny-specific live authentication,
headers and expiry interaction are not yet verified by a termination canary.

## Last completed slice

`videoAsset.service.js` now maps management statuses **5 and 6** to terminal
failure, retaining `BUNNY_TRANSCODE_FAILED` for compatibility. State fences
preserve ready/failed/deleting/deleted generations. No direct webhook mapping.
Red-before-green status-6 regression, **63/63** nearest tests and independent
read-only source review passed. Recorded in the existing recovery/plan/tracker.

## Current unfinished slice: TUS-aware durable cleanup

Files changed in this paused slice:

- `src/domains/videos/provider/bunnyStreamAdapter.js`
- `src/domains/videos/provider/videoAsset.service.js`
- `src/domains/videos/provider/videoProviderRuntime.js`
- `test/domains/videos/provider/bunnyStreamAdapter.test.js`
- `test/domains/videos/provider/videoUploadCleanup.test.js` (new)
- `test/domains/videos/provider/videoProviderRuntime.test.js`
- `test/domains/videos/provider/videoPoster.test.js`
- `test/domains/videos/productVideos/productVideoApplication.test.js`

Current behavior:

- Adapter `terminateTusUpload({ videoId, uploadUrl })` validates the strict
  Bunny URL, signs a fresh server-only authorization for up to 60 seconds,
  disables redirects/API-key forwarding, sends TUS DELETE, accepts only 204
  with protocol header 1.0.0, and treats TUS 404 as `not_found`.
  Other statuses/timeouts remain typed errors. No client grant is renewed.
- Observer replaces `isDeletionAuthorized` with `getDeletionTarget`, returning
  the persisted asset selected by operation asset/library/GUID and deletion
  intent. Repository query is unchanged. All known old test callers were updated.
- Worker terminates a recorded TUS URL before management DELETE. Rejected
  termination blocks DELETE and local acceptance, unless an uncertain request
  can be resolved by matching management GET 404.
- Product Q93/Q96 local removal still follows successful management DELETE
  acceptance (or confirmed absence), not delayed physical deletion.
- Durable operation completes only after management GET 404 and poster cleanup.
  Accepted-but-still-present/error cases remain due. Restart sees persisted
  `deleteAcceptedAt` and verifies without repeating destructive requests.
  `verify_deletion` remains read-only. Unknown/unissued assets without a stored
  TUS URL retain management-only cleanup, followed by GET confirmation.
- No new schema fields, operations, queue, dependency, endpoint or config.

Proof at pause:

- Adapter termination tracer failed before implementation and passed after.
- Worker termination/deletion/GET tracer failed before wiring and passed after.
- New adapter + cleanup suites: **40 passed, 0 failed**.
- Nearest combined suites below: **102 passed, 0 failed**. Initial combined run
  had 101 passed/1 failed because one old successful-delete fake lacked GET;
  the missing fake GET 404 was added and the rerun passed all 102.
- Syntax checks passed for adapter, runtime and new cleanup test.
- No full-suite rerun, current cleanup independent review, final whitespace
  check, live Bunny/Mongo/Redis/device proof or deployment in this paused slice.
- No running test processes remain. No live resources were allocated.

## Immediate continuation and stopping condition

1. Inspect the actual current cleanup implementation and test expectations.
   Confirm that adapter/worker errors cannot treat TUS 404 as video absence,
   bypass rejected deletion, mutate a foreign generation, or lose durable work.
2. Review uncertain TUS termination + management GET 404 specifically: does it
   sufficiently exclude an in-flight upload reappearing, or must termination
   itself be established before closing the obligation? Also review malformed
   termination responses, transport timeout, fresh-signature expiry, legacy
   `deletedAt` meaning, lease loss, callback/persistence failure and retry paths.
   Do not silently claim these subtleties proven by the current happy-path tests.
3. Finish justified missing regressions through the approved seams, with fake
   external adapters and red-before-green for any new behavior.
4. Run nearest tests, then the full Videos suite because shared cleanup reaches
   Product, Reel, editorial and poster workflows. Fix actual regressions without
   unrelated cleanup. Inspect untracked files as well as `git diff`.
5. Obtain a focused independent source review, syntax/import and scoped whitespace
   checks. Record actual results in the plan/recovery/checklist. Mark local cleanup
   implemented only when complete; keep its real-provider acceptance separate.
6. Stop this slice when local behavior and review pass. Do not enable flags or
   automatically run a live canary. If exact Bunny termination semantics require
   new live evidence, propose a bounded hypothesis/resources/cleanup for approval.

## Verification commands

Focused (PowerShell):

```powershell
node --test --experimental-test-isolation=none `
  test/domains/videos/provider/videoProviderRuntime.test.js `
  test/domains/videos/provider/videoUploadCleanup.test.js `
  test/domains/videos/provider/bunnyStreamAdapter.test.js `
  test/domains/videos/provider/videoPoster.test.js `
  test/domains/videos/productVideos/productVideoApplication.test.js
```

Full:

```powershell
$videoTestFiles = @(rg --files test/domains/videos -g '*.test.js')
node --test --experimental-test-isolation=none --test-reporter=tap @videoTestFiles 2>&1 |
  Select-String '^not ok','error:','^# tests','^# pass','^# fail','^# duration_ms'
exit $LASTEXITCODE
```

The previous full Videos result was **617/617 on 2026-10-02**, not refreshed.
The status-6 slice added one test; cleanup adds three adapter tests and eight
worker tests. Do not infer a passing new total without running the suite.
Node test isolation previously hit Windows `spawn EPERM`; no-isolation is the
established workaround. Sandbox loopback fetch returned `EACCES`; relevant HTTP
tests passed with approved local-loopback execution. A local fake-HTTP test
does not require a Bunny secret or live request.

## What follows this slice

Use `VIDEOS_TODO.md` for exact IDs and acceptance, not a completion percentage.

1. **V3.10:** Existing provider-status-0 abandonment at the original 24-hour
   deadline, with generation/owner/placement checks, durable termination and
   cleanup. Preserve processing/ready media and existing setup recovery.
2. **V3.11 / Q142:** Non-resumable fallback creates a new generation while
   preserving Product Video ID, reserved slot, order, visibility and original
   abandonment deadline. Persist setup markers before provider calls outside
   Mongo transactions; durably attach GUID before TUS POST; compensate losing,
   uncertain and late generations. FE must resend the file. No blind retries
   of uncertain creation and no changing a ready winning generation.
3. **V5.09.2:** Apply/prove equivalent full upload lifetime and recovery for
   manual Reel initial/replacement uploads while preserving review/public media.
4. **V3.12.A / V5.15 / V5.16:** Guarded orphan recovery and bounded worker wiring
   exist locally. The worker setting defaults false and the HTTP service keeps
   cleanup disabled. Remaining real acceptance, activation/rollout and removal of the hard-off Reel pipeline
   guard remain separate gates, not accomplished by editing environment flags.
5. **FINAL.01–03:** Locally complete. Domain enums are in existing
   `src/shared/constants/enums.js`, preserving values, schema subsets, APIs,
   transitions and architecture. Before/after verification and independent
   review passed; protocol strings and test expectations remain literal.
6. **FINAL.04:** Only after remaining backend work and acceptance are complete,
   ask the user for the precise contents of the fully detailed
   frontend Markdown handoff. Do not invent its scope or claim client readiness
   merely because backend fake tests pass.
7. **V7/V8/V9 acceptance:** Real Mongo indexes/TTL/transactions/races, isolated
   Redis/worker restart/lease tests, signed webhooks, provider termination and
   upload/expiry/deletion, signed HLS/posters on Android/iOS, user/guest saves,
   analytics telemetry/reporting and actual admin/Flutter integration. Agree
   exact isolated targets/resources and cleanup before external writes.
8. Separately authorized deployment, releases/version gate, staged staff-upload
   enablement and independent public flags, rollback and final sign-off.

## Existing documents/source to consult when needed

- `VIDEOS_FEATURE_DECISIONS.md`: accepted product rules Q1–Q162.
- `VIDEOS_API_CONTRACT_PLAN.md`, `PRODUCT_MEDIA_CONTRACT_PLAN.md`: API contracts.
- `CONTEXT.md`, ADR-0001/0002/0003: vocabulary, Stream choice, editorial/assets
  separation and Mongo-backed provider obligations executed by BullMQ.
- `PRODUCT_VIDEO_EXPIRY_RECOVERY.md`: current provider guidance and generation
  recovery design; old ambiguity sections are explicitly historical.
- `BUNNY_TUS_MEDIA_CANARY_PLAN.md`, `BUNNY_TUS_RECOVERY_CANARY.md`: exact prior
  canary evidence. Two late-PATCH follow-ups returned 408, were cleaned up, and
  did not independently settle the original 204/status-0 observation.
- `src/workers/videoProvider.worker.js`: existing sweep/recovery wiring.
- `src/domains/videos/productVideos/*Recovery*` and replacement repository:
  original deadlines, durable cleanup, slot preservation and stale-generation CAS.
- `src/domains/videos/reels/reelUploadRecovery.*`: initial/replacement ownership,
  cancellation, terminal failures and seven-day rejected replacement cleanup.
- `src/domains/videos/analytics`: V8 local backend complete; its real acceptance
  remains open. Do not reimplement analytics during upload recovery.

All public/upload flags remain off, and Reel/cover have additional pipeline
guards. This checkpoint is a safe local pause, not a production-ready release.
