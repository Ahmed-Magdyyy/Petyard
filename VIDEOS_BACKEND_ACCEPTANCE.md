# PetYard Videos backend acceptance

Checkpoint: 2026-10-10 (Africa/Cairo). This records backend verification and outstanding gates.
The selected local-laptop backend implementation and acceptance checkpoint is
complete. No known unfinished local implementation remains in the accepted scope.
The user's subsequent explicit customer/mobile and admin scope is complete in
`VIDEOS_FRONTEND_HANDOFF.md`; no frontend implementation, deployment, enablement
or full release is claimed.

Latest local regression: **703 passed, zero failures, five opt-in external tests
skipped**, in 22.0 seconds, after editorial/cover/orphan fixture preparation. Real external acceptance results are recorded
separately below; skipped tests are not counted as live acceptance.

Work boundary clarified by the user on 2026-10-09: implementation is on the
local laptop. No Videos code has been pushed or deployed to the VPS yet, so
absent VPS routes, worker and credentials are expected deployment prerequisites,
not missing local implementation. The local worker, raw-body webhook route and
route mounting are present. All five Stream configuration values and
`YOUTUBE_DATA_API_KEY` were rechecked as present in local `.env`; the earlier
successful provider/API calls establish working local credentials. Complete
local backend acceptance first; deployment remains a separate later stage.

## Authorized scope and isolation

The user approved the supplied copied MongoDB database and local Redis for tests.
The runner reads the URI only from `VIDEOS_ACCEPTANCE_MONGO_URI`; credentials are
not stored in this document or source. It does not load dotenv or use the
application's ambient database connection or queue prefix.

Each run uses a separate Mongoose connection, clones the actual schemas into
18 temporary collections, and creates a random `videos_acceptance_*` namespace.
The runner first verifies that the MongoDB and Redis namespaces are unused.
It records collections as owned only after creation succeeds. Cleanup attempts
every owned resource even after another cleanup step fails, then checks that
the collections and Redis queue keys are gone. It never drops the database,
flushes Redis, or reads or modifies copied customer records.

Bunny Stream, TUS, image storage and YouTube verification are mocked. The Redis
failure test disconnects only its own client; it does not stop the shared Redis
instance. The BullMQ worker is an isolated test instance, not the production
worker entry point. Synthetic raw records deliberately omit unrelated domain
metadata in query-focused tests; these tests do not establish every input or
authentication validation rule.

## Checks exercised against real MongoDB and Redis

| Area | Evidence covered | Limit |
| --- | --- | --- |
| Schema indexes | Actual index creation for all cloned schemas, including unique and TTL indexes | Does not inspect or migrate application collections |
| Product reservation | Concurrent batches compete for the three-slot limit; losing transaction rolls back | Provider allocation is mocked |
| Unknown-GUID recovery | Exclusive claims for five reservation paths; transactional Reel adoption survives lost queue acknowledgment | Positive discovery response is mocked |
| Provider obligations | Competing claims, expired lease recovery and stale-token rejection | Does not establish production process supervision |
| Redis recovery | Test-client disconnection preserves Mongo obligations; reconnection redispatches; a fresh BullMQ worker completes cleanup | Does not stop Redis or restart a deployed process |
| Editorial review | Approval stays hidden until Publish; pending edits stay private until approval | YouTube eligibility verifier is mocked |
| Public feed | Real Reel/Product lookups, union, visibility filtering and pagination | Signed playback and devices remain separate |
| Ordering | Stale bulk entries roll back; competing revision updates serialize | Browser drag interactions remain separate |
| Saves | Concurrent duplicate requests, typed user/guest isolation and actual transition counts | Client integration remains separate |
| Permanent deletion | Concurrent save/delete leaves no owner or orphan saves; cover/delete retains cleanup obligations | Storage deletion is mocked |
| Covers | Reviewed attachment remains private; approval switches the cover; removal records durable cleanup | No image bytes or CDN delivery tested |
| Player-error alerts | Concurrent reports deduplicate into the isolated outbox; only eligible staff receive obligations | FCM delivery is not exercised |
| Analytics | Exact retry contention, shared daily upserts, ownership, expiry independent of TTL, aggregate-failure rollback, removed-media rejection and concurrent YouTube/Reel/Product visibility changes | Live provider generation races and device telemetry remain separate |
| Reel replacement | Current media remains until transactional cutover; old-media cleanup persists | Readiness/provider playback are mocked |
| Product deletion race | Replacement versus whole-Product deletion retains both media cleanup obligations | No real provider deletion |
| Non-resumable upload recovery | Product/Reel initial/replacement paths wait for old cleanup, preserve identity/deadline and keep current replacement media | TUS observations, termination and replacement allocation are mocked |
| TTL cleanup | The actual MongoDB monitor removes expired playback, event, daily and attempt canaries | Retention policy correctness also relies on the existing local tests |

The reproducible runner is `test/domains/videos/provider/videoDatabaseAcceptance.test.js`.
It runs only when `VIDEOS_ACCEPTANCE_ENABLED=true` and an explicitly approved URI
is supplied through the process environment. The normal regression suite skips
this external test. Run it with:

```powershell
node --test --experimental-test-isolation=none test/domains/videos/provider/videoDatabaseAcceptance.test.js
```

Final successful run: **24/24 acceptance checks passed**, 0 failed, 0 skipped
(Node reports 25 passed including the parent), in 131.6 seconds. Cleanup verified
that all 18 temporary collections and queue keys were removed. Local regression:
702 Videos tests passed with one opt-in external test skipped; 14 selected
Product tests passed. All 168 scoped JavaScript files passed syntax checks and
693 relative imports resolved; source and checkpoint whitespace checks passed.
The latest implementation-plan checkpoint and `VIDEOS_TODO.md` retain the same
evidence. Earlier failed fixture runs are not counted as
successful acceptance. The missing Product slug and absent-cover assertions
were test defects, corrected without weakening the application indexes or DTOs.

## Automatic orphan recovery implementation

The provider worker now constructs a bounded orphan sweep only when
`VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED=true`. Its default is false, and malformed
values fail configuration validation. The sweep covers Product initial uploads,
Product replacements, Product resource recovery, Reel upload sessions and Reel
resource recovery. It uses one global maximum of 100 candidates per sweep and
claims the expected `updatedAt` before provider inspection. Probe spacing uses
the configured operation lease interval. Failure dates and abandonment deadlines
remain unchanged.

The existing exact-marker/library/time/empty-media checks and transactional owner
adoption remain authoritative. Ambiguous, non-empty, missing, stale and already
tracked results are deferred. A failed candidate does not prevent another owner
from being checked. No HTTP cleanup endpoint was added. Implementation of this
path does not authorize enabling it in production.

## Real provider acceptance — 2026-10-09

The user explicitly approved sending the configured YouTube key to Google's
YouTube API and Bunny credentials to Bunny Stream/storage/CDN for at most three
synthetic videos and three unique image objects. This followed a sandbox DNS
failure and automatic approval rejection; the initial failed run created no
provider resources. The successful network-enabled run used Stream library
`754739` and public storage zone `petyardpublicmedia`. These are configured
resources, not claimed to be dedicated staging resources. Only this run's
markers, captured GUIDs and random image keys were written or deleted.

`test/domains/videos/provider/videoProviderAcceptance.mjs` passed:

- Real YouTube Data API public/processed/embeddable eligibility verification.
- A 7,062-byte synthetic MP4 uploaded in two PATCH requests, with a HEAD-confirmed
  partial offset of 3,531 bytes, then completion using a fresh authorization.
  This tests interrupted-request resume and new authorization, not a PATCH that
  remains open across token expiry or a 24-hour abandoned session.
- Empty TUS termination returned the strict expected response; subsequent HEAD
  confirmed that the resource was absent.
- Valid media reached provider status 4, with a two-second duration. Signed HLS
  probing returned a usable playlist and the signed thumbnail read returned
  4,610 image bytes. Invalid synthetic bytes reached processing-failure status 5.
- Actual poster and portrait-cover stores performed real WebP PUTs. Authenticated
  storage reads decoded the WebP bytes, and public CDN reads returned HTTP 200.
- A cover PUT succeeded at storage before an injected caller error discarded its
  result. The pre-recorded deterministic key still allowed exact cleanup. This
  is a simulated lost response after a real PUT, not an induced network outage
  or a transaction-coupled attachment/deletion race.
- All three image origin reads returned 404 after deletion. All three TUS
  resources were terminated or already absent, and all three management video
  GETs returned 404 after deletion. Cleanup passed with 32 guarded provider
  requests; `.env` was unchanged. CDN cache eviction after deletion was not proved.

The private cleanup manifest, including TUS URLs, stays under ignored `scripts/`;
it contains no API keys and is never printed. The scope is consumed. A rerun
cannot allocate more resources from this manifest. No customer records, media,
queues, feature flags or rollout guards were changed. The script's cleanup was
independently reviewed; management absence and TUS absence are handled separately.

## Actual standalone worker process — 2026-10-09

`test/domains/videos/provider/videoWorkerProcessAcceptance.test.js` passed in
24.0 seconds with 0 failures and 0 skips. It launches the actual
`src/workers/videoProvider.worker.js` entry point through a test-only bootstrap.
The bootstrap bypasses ambient dotenv loading, supplies explicit test settings,
prefixes every registered model collection and rejects provider HTTP. The parent
uses the approved copied MongoDB and local Redis, first verifies unused namespaces,
and verifies collection/queue removal after both child processes stop.

The first process discovers an unqueued deletion obligation with a missing owner,
records `VIDEO_DELETE_NOT_AUTHORIZED` and keeps the obligation durable. After
SIGKILL, the parent makes that failed obligation due and starts a new process;
the restarted worker processes it again. IPC triggers the entry point's SIGTERM
handler for the final shutdown, which exits with code 0. No provider HTTP occurred.
This proves local entry-point startup, restart, redispatch and graceful shutdown.
It does not prove interruption during a running provider operation, production
process supervision, or deployed dotenv/secret loading. Lease expiry and stale
tokens were separately proved by the copied-database runner above.

## Notification transport and deployed-route discovery — 2026-10-09

The user explicitly authorized one test notification to all devices belonging
to super-admin `691abbbbc2b6dc546f3e730f`. The configured MongoDB was used only
for reading that account and its registrations; other acceptance writes still
use the previously approved copy and temporary namespaces. The recipient's
active super-admin role was verified. Nine distinct tokens were registered
across Android and iOS. `videoNotificationAcceptance.mjs` sent one clearly
labelled `Petyard Videos test` message through the configured Firebase Admin
transport: **9 accepted, 0 failed**. Tokens and credentials were not printed,
no database records/registrations were changed, and the one-send manifest stops
retries after an uncertain result. Firebase acceptance is not phone-display
evidence; the user was asked to confirm receipt. This is a transport test, not
an end-to-end Videos alert/outbox/dispatcher/device acceptance claim.

The subsequent **full local Videos notification pipeline passed** using
`videoNotificationPipelineAcceptance.test.js`. Two identical player-error reports
through the real public service and transaction repository produced one isolated
outbox obligation for the approved account. The actual claim/delivery worker and
default dispatcher created one isolated in-app record and Firebase accepted
**nine pushes, zero failures**; the outbox became Sent and could not be reclaimed.
Before delivery, the synthetic obligation was clearly labelled
`Petyard Videos pipeline test`. The configured database was read only for this
account/devices. Dispatcher persistence/device methods were routed to five
temporary copied-Mongo collections; actual Firebase transport was used. All five
collections were removed and absence verified. Customer records and registrations
were unchanged. Phone display still needs the user's confirmation; the isolated
in-app record was deliberately removed, so this does not prove an inbox entry in
the deployed app. The ignored one-send manifest prevents automatic resending.
Independent source review found no actionable issue in recipient isolation,
dispatcher model routing, one-send protection or cleanup. It did not repeat
provider calls or compare customer database snapshots; the no-customer-write
conclusion follows the isolated write paths.

The user subsequently confirmed receipt on their Android phone and supplied a
screenshot showing both `Petyard Videos test` and `Petyard Videos pipeline test`.
This closes the approved recipient's Android notification-display check. It
does not establish display on every registered device or on iOS, or a deployed
in-app inbox entry.

The existing local admin client's API configuration identifies
`https://api.petyardstores.com`. Unauthenticated probes confirmed that both
`GET /api/v1/videos/admin` and an empty, unsigned
`POST /api/v1/integrations/bunny-stream/webhook` return HTTP 400 with the
application's `can't find this route` message. OPTIONS returns generic 204,
which does not establish route availability. The discovered public API therefore
does not currently expose these Videos routes. The local webhook implementation
exists and has signature-validation tests; public endpoint deployment and
Bunny webhook configuration are still missing. No deployed configuration was
changed, no valid webhook was sent, and no customer notification was sent beyond
the specifically approved account.

Read-only SSH inspection of the configured Petyard VPS corroborated this finding:
deployed revision `6f0bf36` has neither the provider worker nor webhook route file,
and PM2 has no Videos provider worker. The deployed environment has Redis and
public image storage settings but lacks all five Stream settings and the YouTube
Data API key. The existing API/notification workers use Node 22.23.3. The local
Videos PM2 definition now explicitly uses the shared `nodeInterpreter`; a focused
configuration assertion and syntax check passed. The remote checkout has an
existing `src/app/server.js` change, which must be preserved during deployment.
No server file, environment, PM2 process or provider setting was changed.

## Combined provider/database recovery — all four paths accepted

`videoLiveRecoveryAcceptance.test.js` is ready for a separate, explicitly approved
scope of at most ten synthetic Stream videos and twelve temporary copied-Mongo
collections. It reuses the four Product/Reel initial/replacement recovery cases
from the database fixture. Live replacement cases upload actual current media
and apply the real provider snapshot before establishing the synthetic published
fixture. The old TUS resource is terminated and HEAD-checked before recovery;
the real application runtime must confirm old-video absence before a new
allocation, while retaining owner/session/replacement identity and deadline.

The user's continuation authorized this scope. The first run failed all four
cases after five allocations: a frozen fixture clock attempted to claim work
before its recorded due time, and Reel TUS metadata replaced the saved provider
title. Live fixtures now use real time; Reel creation and TUS metadata use the
same persisted reservation marker. The focused twelve Reel upload tests and
the full regression passed: **702 passed, zero failed, three opt-in skips**.

The remaining five allocations in the same cumulative ten-video scope exercised
**Product initial recovery and Reel replacement recovery successfully**. Both
preserved identity and deadline; real old-resource termination/HEAD absence and
management-video absence preceded replacement allocation. The Reel replacement
case preserved its real uploaded Ready current media. Product replacement and
Reel initial recovery were subsequently accepted in the separately approved
five-video follow-up below. Failed cases are not counted as acceptance.

Cleanup-only verification passed after the run: **ten management videos absent,
seven unfinished TUS resources absent, twelve temporary Mongo collections gone**.
For three completed uploads, Bunny accepted TUS termination but still returned
HEAD 200 with the full offset. Fresh valid-library PATCH requests after media
deletion returned HTTP 401. These are **retained completed TUS metadata with
verified write denial**, not confirmed TUS resource absence. The private manifest
retains that distinction. The original three-video canary's completed-resource
termination acknowledgments likewise must not be described as independent HEAD
404 proof. No customer media/records, environment settings or flags changed.

Independent review found no actionable issue in the clock, marker and bounded
continuation fixes. TUS requests without a known resource URL retain an unresolved
obligation. Unfinished TUS absence requires HEAD 404. Collection intent is persisted before
creation; a permissive Mongo validator carries the unique run ownership marker,
which cleanup verifies before dropping a collection after an uncertain create.
A one-collection copied-Mongo probe verified that marker preservation, valid
fixture insertion and exact cleanup. Provider requests have an invocation limit
of 180; allocations are never retried after an unknown outcome, and cleanup-only
can resume from the ignored private manifest.

The modified shared fixture passed the complete copied-Mongo/local-Redis runner
again: **24/24 checks**, zero failures/skips (25 including parent), 137.7 seconds,
with verified resource cleanup. This still uses mocked Bunny responses. The
ten-video live scope is now consumed; it may be opened only for cleanup checks.
The final normal Videos regression also passed: **702 passed, 0 failed,
4 opt-in external checks skipped**, in 5.5 seconds. The external checks are the
copied-database runner, standalone-process runner, live recovery runner and
notification-pipeline runner.

## Local backend acceptance checkpoint

### Live editorial/cover/orphan acceptance — 2026-10-10

The user instructed `next` after the concrete four-video/two-cover/twelve-collection
approval request. Preflight confirmed the fixed scope was unused and flags off.
The live run passed **all three checks plus the parent: 4 passed, 0 failed,
0 skipped**, 159.2 seconds, using actual Bunny Stream/storage/CDN and the
approved Mongo copy. No production-code change was required.

- Admin Reel approval remained hidden until separate Publish. Pending replacement
  media and cover were excluded from the public response until reviewed cutover.
  Actual signed HLS preview succeeded; an unprivileged preview request returned
  403 before any provider call. Durable runtime cleanup removed old media and
  both cover generations.
- A super-admin Ready Reel stayed Draft after one injected denied verifier result.
  The next successful actual signed-HLS verification published it automatically.
- An injected lost caller response after actual Bunny create left an unissued
  failed reservation without a persisted GUID. Exact-marker discovery and two
  competing sweeps adopted it once; one observed lost queue acknowledgment left
  a durable cleanup operation, which the runtime completed. Replay did not
  allocate or revive media. This live orphan case is Reel initial creation;
  the five owner-path Mongo claim checks and other discovery cases retain their
  previously recorded mock/component evidence.

Cleanup verified management GET 404 for all **four Stream videos**, authenticated
origin GET 404 for **both cover objects**, and absence of all **twelve marked
temporary collections**. The empty orphan had no TUS allocation. Three completed
TUS metadata records remain readable but fresh PATCH was denied: **401, 404, 404**.
Both already-read public cover URLs still returned CDN **200** after origin
deletion. Origin removal is proved; immediate cache eviction is not. No purge
was performed or promised, and no removed cover remains in the public response.

The private manifest independently confirms three case records, the successful
aggregate, all owned media/origins absent, zero cleanup failures, **102 provider
requests** and unchanged `.env`. The scope is consumed; this manifest can be
used only for cleanup checks, never fresh allocation. Source review and the
preceding normal Videos regression remain valid: **703 passed, 0 failed,
5 opt-in external skips**, 22.0 seconds. No code changed after that regression.
No notifications, customer-record writes, flags, guards, commits, pushes or
deployment changed. Later client/deployment gates remain open below.

### Preparation evidence, superseded by the live result above

Editorial/cover/orphan preparation, 2026-10-09: the new shared fixture passed on
the approved Mongo copy with simulated providers: **4 passed including the parent,
0 failures/skips**, 57.2 seconds. All eighteen ownership-marked temporary
collections were removed and absence verified. The initial fixture omitted
required `kind: reel`; that input was corrected without production-code changes.
Focused independent review found a missing unauthorized-preview assertion;
the strengthened successful run verifies 403 with zero provider calls.

The selected checks use actual repositories, services, Mongo transactions and
durable provider runtime: admin initial approval stays hidden until separate
Publish; a pending replacement and cover stay out of the public response until
reviewed cutover; old media and both covers complete durable cleanup. A
super-admin Ready Reel remains Draft after one injected denied preview result,
then publishes on a successful verifier retry. A lost create response retains a
failed unissued reservation; exact-marker discovery plus two concurrent sweeps
adopt exactly once, and the runtime completes cleanup despite one observed
queue-acknowledgment loss. The simulated HLS/storage responses do not prove live
Bunny outcomes.

Prepared live scope: at most **four synthetic Stream videos, two unique portrait
cover objects and twelve owned collections**, one fixed private manifest under
`scripts/videos-live-editorial-orphan-20261009/`, 180 work requests and 50 reserved
cleanup requests. Stream mutations target only captured GUIDs/markers/TUS URLs;
cover PUT requires an existing reservation in this run's cloned cover collection.
Storage mutations/reads and CDN reads use only the two captured object keys.
The fixture probes actual signed HLS for publication/review. Origin GET 404 and
the observed post-deletion CDN status are recorded separately; immediate CDN
eviction is not promised. Final no-network preflight and focused source review
passed. The scope was unapproved at this preparation checkpoint; the user's
subsequent `next` and successful live run above supersede that state. All scopes
are now consumed. Frontend document contents await clarification; rollout stays
deferred.

The two remaining selected provider-coupled replacement races passed on
2026-10-09. No new production-code defect was found in these final checks.
This closes the selected local acceptance checks; broader client, deployment,
provider coupling and enablement gates remain open in `VIDEOS_TODO.md`.

The separately approved four-video/twelve-collection run used the actual Bunny
adapter, real upload services, asset observer, Mongo transactions and durable
provider runtime. Whole-Product deletion during a held replacement Ready response
deleted both generations, released the slot and blocked late replay. Reel
replacement cancellation during held Ready deleted the pending generation while
preserving the published current asset and upload session. The Reel's publication
was seeded in isolated data; this check does not establish publication authority.
Both checks and the parent passed: **3 passed, 0 failed, 0 skipped**, 145.5 seconds.

Cleanup verified exact management GET 404 for all four videos and absence of all
twelve ownership-marked collections. Four completed TUS metadata records remain
readable; fresh post-deletion PATCH returned **401, 401, 404, 404**. Media absence
and write denial are proved separately from physical TUS metadata removal.
The private manifest confirms both cases passed, zero cleanup failures, 95 total
provider requests and unchanged `.env`. This scope is consumed; further provider
allocation requires a separately approved bounded scope. No images or customer
records were changed; no flags, guards, commit, push or deployment changed.

These earlier replacement races did not establish orphan adoption or reviewed
cover cutover; the newer scoped live result above now supplies that evidence.
Other owner paths retain their component evidence, and CDN cache eviction remains
unproved. Full release gates remain explicitly scoped in the checklist.

- Replacement-race preparation, 2026-10-09: both new checks passed against the
  approved Mongo copy with an in-memory provider (3 tests including the parent,
  0 failures, 63.2 seconds). Product cascade deletion removed both current and
  pending generations despite a held Ready response. Reel replacement cancellation
  removed the pending generation while retaining the published current asset and
  session. All 18 ownership-marked temporary collections were removed and absence
  verified. The first fixture run rejected a Product-only `clientId` on the Reel
  request; the corrected Reel payload passed. This was a fixture correction.
  The exact same flow is prepared for live Bunny with at most **four synthetic
  videos and twelve isolated collections**, 180 work requests plus 40 reserved
  cleanup requests, exact owned targets, and a fixed private one-run manifest.
  No-network preflight passed with flags off and no prior manifest. Focused
  independent source review found no actionable issue. Normal Videos regression:
  **703 passed, 0 failed, 5 opt-in external skips**, 22.5 seconds. This new live
  preparation checkpoint was followed by the separately approved successful live
  run above; all earlier allowances remain consumed.
- The newly approved three-video/three-image scope is consumed and cleaned up.
  Any additional provider allocations require a concrete new bounded scope.
- All four Product/Reel initial/replacement non-resumable recovery cases now
  have successful real-provider/copied-database evidence. The selected replacement
  generation races and live Product deletion/late-response race also passed.
  Portrait/landscape media, upload/HLS expiry and real over-limit
  duration rejection now have the bounded provider evidence below.
- The selected live provider-coupled replacement-generation checks are complete.
  The copied-database
  run now includes concurrent analytics visibility changes for all three kinds,
  but mocked provider responses do not establish those external outcomes.
- The approved user's Android notification display and local
  alert/outbox/dispatcher path passed, with nine Firebase acceptances and no
  failures. Other devices/iOS and deployed inbox display remain client gates;
  do not extend the recipient scope to other users.

The separately approved **five-video follow-up passed both recovery cases**:
Product replacement preserved its real Ready current media, and Reel initial
recovery preserved session identity and deadline. Signed local HTTP webhook
replay also passed: unsigned request rejected, two valid identical replays
acknowledged, one durable hint, injected enqueue loss, then sweep redispatch and
real Bunny GET before setting the asset Ready. This is a locally signed replay,
not evidence that Bunny delivered a callback to a deployed HTTPS endpoint.

All five management videos and twelve temporary Mongo collections were removed
with verified absence. Four unfinished TUS resources returned HEAD 404. One
completed TUS resource still returned readable completion metadata; subsequent
PATCH returned 404. Cleanup-only verification passed after the test was corrected
to accept authorization denial (401/403) or resource absence (404/410), rather
than requiring one specific rejection status. No successful upload response,
payload-limit error or server error qualifies as write denial. The five-video
scope and prior ten-video scope are consumed; they allow cleanup checks only.

The approved **two-video media scope was executed and consumed**. One of its
two cases passed: Bunny verified the synthetic Reel at 92 seconds, and the real
observer/recovery/runtime rejected it with `VIDEO_DURATION_EXCEEDED`, detached
the owner, persisted and completed cleanup, and rejected late replay.

The portrait case stopped at its expired-grant assertion: the test expected
401/403. A diagnostic against an already deleted, exact owned resource returned
HTTP 400 with an explicit expiry reason. That diagnostic identifies the provider
response category; it does not prove expiry/resume on a live portrait resource.
The test now accepts 400 only with explicit expiry text and still requires
unchanged offset, service refresh on the same resource/deadline and a successful
fresh PATCH. No backend behavior changed for this test correction.

Both management GUIDs returned GET 404, all twelve owned Mongo collections
were absent, and `.env` was unchanged. The unfinished TUS resource returned
HEAD 404; completed metadata remained readable but PATCH returned 404.
The original aggregate record incorrectly claimed two completed cases despite
the failed subtest. An appended correction records one pass and one failure.
The harness now counts successful cases and requires every selected case to
pass before recording combined acceptance.

The approved **one-video portrait retry was executed and consumed**. It failed
at the same boundary because the corrected parser still required the word
`expired`. Bunny instead reports an invalid expiry time in the past. The failed
case is recorded as zero successful cases, without a combined-acceptance claim.
Its management video, unfinished TUS resource and twelve temporary collections
were removed with verified absence; `.env` was unchanged.

The parser now recognizes explicit expiry-in-the-past wording and rejects
unrelated expiry-format/future-limit errors. It was checked against the actual
provider response using one already deleted exact synthetic resource; no new
video was allocated. The focused rejection test passed. This diagnostic does
not establish live-resource resume by itself.

The separately approved **second one-video retry is also consumed**. Portrait
transcoding passed, expired TUS PATCH returned 400 with explicit expiry wording,
fresh HEAD confirmed unchanged offset, actual service refresh retained the exact
resource and deadline, and fresh PATCH completed upload. Signed HLS returned
200 before expiry and 403 afterward. The deletion-race step then failed because
the fixture had not applied the verified Ready snapshot to the application;
the real repository correctly refuses deletion of an unfinished placement.
This is partial positive evidence, not a successful combined case.

Cleanup verified its management video and twelve collections absent. Completed
TUS metadata remains readable but PATCH returned 404; `.env` was unchanged.
The corrected race fixture now applies the real Ready snapshot first, holds a
second real GET, and requests deletion while that response is held. Before
provider acceptance, the asset remains Ready with deletion intent and the
placement is Deleting; after cleanup they must be Deleted and Removed.
The separately approved **deletion-only one-video run passed**. Deletion intent
won against the held real provider Ready response, the runtime completed actual
provider deletion, the placement became Removed with its slot released, and a
late replay did not revive the Deleted asset. It did not repeat expiry tests.
Cleanup verified the management GUID and twelve owned collections absent;
completed TUS metadata remains readable but PATCH returned 404. `.env` was
unchanged. This scope is consumed; it permits cleanup diagnostics only.
Forty relevant local tests passed after the fixture setup correction.
The normal regression passed 703 tests, zero failures, four external skips
before the final parser wording correction; the focused test passed afterward.

## Focused database failure, alert races and in-flight worker restart — 2026-10-09

`videoDatabaseFailureAcceptance.test.js` passed both checks against the approved
copy (18.8 seconds; three TAP passes including the parent). Eight ownership-marked
temporary collections were removed with verified absence. After a real successful
analytics commit, an injected `UnknownTransactionCommitResult` caused two commit
attempts and one transaction callback. Exactly one event, one session count and
one daily share persisted; caller replay was a duplicate without increasing
totals. This simulates acknowledgment loss after a real server commit; it does
not interrupt the Atlas network. Closing only the isolated Mongo client caused
session issuance to return safe 503 without adding a session; reconnect verified
the unchanged count.

The focused `VIDEOS_ACCEPTANCE_ALERT_RACES_ONLY=true` branch of the existing
database runner passed two checks (31.9 seconds; three TAP passes including the
parent). It used eighteen owned temporary collections, no Redis commands and no
notification/provider delivery. Concurrent report versus delete/unpublish/link
change produced a consistent outcome: an alert may commit first, while all later
reports for the obsolete owner state are refused. Subsequent decisions excluded
staff with revoked controls, inactive accounts and banned accounts. This checks
eligibility at decision time, without promising revocation of an already committed
notification. All owned collections were absent after cleanup. The runner now
records collection intent before creation and checks its ownership marker before
dropping, covering a lost creation acknowledgment.

The expanded `videoWorkerProcessAcceptance.test.js` passed in 99.5 seconds.
The actual entry point reached a held simulated DELETE, was killed with SIGKILL,
and left its Mongo operation Running and asset Deleting. Only that owned lease
was advanced to expired. Restart retained and reclaimed the real stalled BullMQ
job, completed simulated Stream deletion/GET absence and exact poster cleanup,
marked the obligation Completed and asset Deleted, then shut down through SIGTERM.
All owned Mongo collections and Redis keys were removed with verified absence.
Provider HTTP was intercepted for one literal synthetic GUID and one exact
owned poster path; no real Bunny resource or image object was allocated.
This proves local interruption/restart with real persistence/queue state, rather
than a deployed process crash or real provider side effects during that crash.
The earlier failed attempts exposed a wait allowance and missing poster-store
fixture; those were corrected without changing production worker behavior.

## Later deployment and release gates

- Deploy the locally implemented webhook/worker and securely deliver the
  already configured credentials. Validate the public webhook endpoint before
  configuring Bunny and prove missed-webhook reconciliation. Its absence on
  the VPS is expected until this local work is released.
- Prove deployed worker supervision and restart during provider work.
  Local entry-point startup/restart/shutdown is already verified above.
- Obtain rollout approval before removing the Reel/cover pipeline guards or
  enabling automatic recovery or public/upload flags. No flags or guards were
  changed by this acceptance run.

Administration browser and Android/iOS acceptance remain client/release gates;
those repositories have not been inspected. They are not evidence of a missing
backend implementation by themselves, and are not claimed complete here.
Deployment, commits and pushes remain separately authorized actions.

The selected local backend checkpoint and subsequent FINAL.04 document are
complete. `VIDEOS_FRONTEND_HANDOFF.md` covers all 53 frontend-facing routes with
field dictionaries, retained client state, workflows, retries, edge cases and
client/release gates. Documentation checks passed 53 routes, 92 local links,
21 JSON examples and 105 headings/anchors; the 11-event analytics example passed
actual validators/policy with 17,100 ms watch time and one qualified view. Source
review included the existing full-server Cairo date replacer and documents its
offsetless wire timestamps. This was documentation-only, without external calls
or a new claim of frontend/device/deployment acceptance.
