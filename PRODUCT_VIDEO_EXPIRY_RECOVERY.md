# Product Video upload-resource expiry recovery

Status: provider semantics clarified on 2026-10-07; Q142 Product recovery is
implemented locally through explicit recovery endpoints, with rollout disabled
and real-system acceptance open. Equivalent Reel recovery is also local under
V5.09.2; its real-system acceptance remains open.
The current guidance below supersedes the
earlier uncertainty notes, which remain as chronological diagnostic evidence.

## Bunny support clarification and first local fix — 2026-10-08

Authority: the user supplied Augusto's reply dated 2026-10-07 21:44:39 from
[Bunny support ticket #431686](https://dash.bunny.net/support/tickets/431686).
The reply was not fetched independently; its displayed timestamp has no stated
timezone. The provider describes a fix planned for the coming weeks, not an
already deployed fix.

- A token can expire during the final PATCH. Bunny may acknowledge the bytes
  without accepting the upload for processing. Such an upload must be treated
  as failed rather than assumed playable from HTTP 204 or a complete offset.
- Management status 0 means no completed upload has been accepted. Bunny does
  not automatically process or delete those objects. Support accepts a 24-hour
  application cutoff, consistent with PetYard's existing abandonment deadline.
- Support describes accepted management progression as 2 (Processing),
  3 (Transcoding), then 4 (Finished), with failures at 5 or 6. Do not remove
  existing handling for status 1 solely because this reply does not mention it.
- A TUS HEAD 404 means that upload session cannot resume. Check the matching
  management video before replacing anything: TUS absence is not video absence.
- For an in-flight upload, terminate the trusted TUS resource before management
  video deletion. Confirm management GET 404 before declaring the provider
  object gone. Product Video local removal still follows Q93/Q96: provider
  deletion acceptance or confirmed absence; this clarification does not change
  that business rule or erase a remaining provider cleanup obligation.
- Authorization must cover the whole upload, not just its start. The configured
  six-hour grant and its original expiry remain unchanged in this slice. A
  fresh signature must not silently extend the original resource lifetime or
  reset the original 24-hour abandonment deadline.

Support's phrase "shortly after" does not specify an exact observation window.
Do not invent an immediate automatic-deletion timeout. TUS termination headers,
response handling and expiry behavior still require focused implementation and
provider acceptance. No new live canary is authorized by the support reply.

The [official webhook documentation](https://bunny.net/docs/stream/webhooks),
checked on 2026-10-08, uses a different status domain: webhook 6 means
`PresignedUploadStarted`, and webhook 8 means `PresignedUploadFailed`.
Keep signed callbacks as reconciliation hints; apply technical state only from
the matching management GET. Never map webhook 6 directly to terminal failure.

Implemented locally: the shared Video Asset observer now treats management
statuses 5 and 6 as terminal failure, retaining the existing safe
`BUNNY_TRANSCODE_FAILED` response code. Existing repository guards protect ready,
failed, deleting and deleted assets; Product Video and Reel consumers retain
their current generation-scoped terminal cleanup behavior. No new schema,
endpoint, queue, dependency, flag or environment value was introduced.

TDD evidence: the new worker-interface status-6 regression failed before the
fix (the asset incorrectly remained processing) and passed afterward. The
worker, webhook, Product Video application and Reel recovery suites passed
63/63 with fake external adapters. Three HTTP tests initially failed because
the sandbox denied loopback connections (`EACCES`); the focused rerun with
loopback access passed. Independent read-only review found no actionable issue.
This is local/source proof, not live Bunny, MongoDB, Redis or device acceptance.

Durable TUS termination/deletion verification is now implemented locally.
Uncertain termination cannot be settled merely by management GET 404; the
obligation remains due until the TUS session is terminated or absent. Product
local removal still follows deletion acceptance, while durable completion also
requires management GET 404 and poster cleanup. Persistence/callback faults and
lease expiry are covered by fake-adapter restart tests. Local proof: 107 nearest
tests, refreshed full Videos suite 634/634 and focused independent source review.
Real Bunny termination authentication, expiry and in-flight behavior are unproven.

Existing status-0 abandonment is also implemented locally for initial/replacement
Product and Reel uploads at their original persisted 24-hour deadlines. Fresh
matching management snapshots reach generation/owner/library/GUID/status-guarded
transactions; processing and ready media are preserved. Cleanup intent and its
durable operation commit with local retirement. Replaced Reel public media and
editable proposal metadata remain intact. Red-before-green deadline tracers,
77 nearest tests, refreshed full Videos suite 646/646 and independent Product/Reel
source reviews passed. Real database/provider races remain unverified.

Product Q142 recovery is now implemented locally for initial and pending
replacement uploads. The client requests recovery with the file descriptor and
a stable recovery idempotency key. A matching management status 0 plus a
fresh-signed trusted TUS HEAD 404, or actual management GET 404, permits a
transactional recovery marker and old-generation cleanup obligation. Resumable,
complete, processing, ready, failed or mismatched observations cannot authorize
new allocation. No caller-provided TUS URL is accepted.

Recovery returns `202 recovering` until the old durable operation completes:
trusted TUS termination/absence, management GET 404 and poster cleanup. A retry
with the same key may then create one new Video Asset and TUS resource and
return `201 awaiting_upload`. The same Product Video ID, slot, position,
visibility, replacement ID and original 24-hour deadline are preserved. Pending
recovery also pins the active ready generation; cancellation or a changed active
generation rejects late adoption and compensates the new resource. The client
must resend the file bytes through HEAD/PATCH to the returned URL.

Uncertain creation retains its generation marker and blocks blind allocation.
Guarded internal orphan inspection/adoption supports this exact marker under
the existing default-off gate; V3.12.A automatic wiring remains unauthorized.
Known late responses, uncertain TUS setup and failed adoption persist cleanup.
The worker's existing setup sweep handles stale/expired recovery markers without
starting another resource. Original authorization refresh remains unchanged.

Local proof on 2026-10-08: 21 new service/HTTP/worker tests and refreshed full
Videos suite 667/667; red-before-green cancellation and active-generation race
tests; focused independent source review. Tests use real internal modules and
fake external boundaries. Real MongoDB/Bunny/Redis races, termination headers,
unknown unissued TUS POST cleanup and device file resend remain acceptance
gates. No live allocation, worker startup or flag change was performed.

Equivalent Reel initial/pending non-resumable recovery is now implemented locally
under V5.09.2. It uses the same provider-evidence and completed-cleanup gates,
preserves the logical session and original deadline, and retains published media,
pending metadata and review authority. Existing cancellation, whole-proposal
removal, permanent deletion and worker setup sweeps fence late responses.
Unknown creates retain their exact recovery marker; internal orphan adoption
remains default-off and unwired. A malformed returned GUID is rejected before
attachment so it cannot create an impossible cleanup obligation.

Local evidence: 24 new Reel service/HTTP/worker/editorial integration tests and
one adapter marker regression; full Videos suite 692/692 and final independent
source review. Fake external boundaries do not prove live MongoDB/Bunny/Redis or
device behavior. The shared adapter now accepts exact Product and Reel recovery
markers, fixing the prior omission for Product recovery orphan searches.
Detailed Product/Reel endpoint and retry contracts are in `VIDEOS_API_CONTRACT_PLAN.md`.
Final enum centralization and frontend handoffs remain implementation work;
V3.11.A/V5.09.2.A real-system acceptance and automatic orphan wiring remain gated.

## Historical recovery gate reconciliation — 2026-10-02

After the V8 analytics backend slices, the remaining recovery tasks were checked
against the current source and the completed canaries. V3.10, V3.11 and V5.09.2
remain incomplete: none of the later observations resolves the earlier full-byte
204 acknowledgement followed by TUS 404 and management status 0. V3.12's
guarded orphan discovery/adoption is implemented locally, but production
`allowOrphanCleanup` remains false and the worker does not invoke it.

Current reconciliation uses a matching management video snapshot. Only an
actual management GET 404 reaches the missing-upload handler; a TUS 404, empty
response, identity mismatch, authorization failure, timeout or transient error
does not authorize abandonment. The original abandonment deadline and current
asset/placement/session checks still apply. Processing and ready generations
are not reclaimed through missing awaiting-upload recovery. Product Video and
Reel refresh keep the original resource/generation and fail closed when it has
expired. Explicit cancellation remains available within its existing controls.

Focused unchanged tests passed 56/56 across Product Video abandonment, setup
recovery and trusted uploads, plus Reel recovery and upload application tests.
This is fake-adapter regression proof, not new Bunny or Mongo acceptance.
The previously recorded 617-test Videos result remains the broader local
baseline; it was not rerun for this documentation-only reconciliation.
No product code, environment, flags, provider resources, database, worker or
deployment was changed. All earlier canary allocations remain consumed.

### Provider clarification to obtain before choosing the next recovery change

The following is a draft to copy to Bunny support. It has not been sent.
Do not include API keys, signatures, signed playback URLs or TUS resource URLs.
The timestamped evidence is in `BUNNY_TUS_MEDIA_CANARY_PLAN.md`; private ignored
manifests retain the exact disposable GUIDs if support needs them.

> We use Bunny Stream with backend-created, persisted TUS resources. In a
> controlled synthetic-video test, the final PATCH returned HTTP 204 with the
> full 7,062-byte upload offset at 2026-09-27 23:01:48 UTC, after the original
> test authorization deadline of 23:01:46 UTC. A fresh-signed HEAD then returned
> 404, while the matching management video GET still reported status 0. We
> deleted the disposable video before observing a later processing state.
> Two separately approved follow-ups returned HTTP 408 before byte completion,
> so they do not resolve the earlier completed-upload outcome. All test videos
> have been deleted and confirmed absent.
>
> 1. Can the fully acknowledged video in that situation still enter processing
>    later? Which authoritative API field or endpoint distinguishes accepted
>    complete source bytes from an empty or permanently incomplete status-0 video?
> 2. Is there a documented terminal condition or guaranteed time bound after
>    which an existing status-0 video cannot subsequently process? Our app's
>    24-hour upload deadline is a local rule; we do not assume it is a Bunny guarantee.
> 3. For a trusted backend-created TUS resource, does HEAD 404 with fresh valid
>    authorization establish permanent non-resumability? How should we safely
>    distinguish this from a completed upload whose management state is delayed?
> 4. If management DELETE is accepted and GET confirms absence while an earlier
>    final PATCH or processing request is still in flight, can that same video
>    GUID reappear or become playable later? What is the authoritative cleanup
>    confirmation we should use before replacing the resource?

Record the provider's precise answer and its supporting API/documentation,
then apply it to the existing conservative decision matrix. A single timing
observation must not be converted into a universal timeout/deletion policy.
Do not silently weaken V3.10/V3.11/V5.09.2 or wire V3.12 automatic cleanup to
declare completion. Any further live canary needs a distinct hypothesis,
bounded resources/cleanup and separate user approval.

## Historical observed facts and authority

The bounded Bunny media canary in `BUNNY_TUS_MEDIA_CANARY_PLAN.md` established
two distinct cases. A completed upload remained TUS-HEAD `complete` and
provider status 4 after its original TUS expiry. B's final PATCH began locally
before expiry and completed afterward with HTTP 204 and full offset, but a
subsequent TUS HEAD returned 404 while management GET still reported status 0.
B was then cleaned up, so its eventual processing outcome is unknown.
An approved one-video follow-up held a fresh final PATCH open across expiry,
but Bunny returned HTTP 408 before its scheduled last bytes; that object was
deleted and confirmed absent. Because no complete follow-up upload was
obtained, B's eventual processing outcome remains unknown. The two different
responses are timing observations, not a safe automatic-replacement rule.

The separately approved one-video repeat on 2026-10-02 also returned 408 before
completion, despite intermediate body chunks. Its final scheduled bytes were
canceled; exact-GUID DELETE returned 200 and two later management GETs confirmed
404. That allocation is consumed and cleaned up, with prior manifests and
`.env` unchanged. It still does not settle B's earlier accepted late-completion
outcome. See the timestamped repeat evidence in `BUNNY_TUS_MEDIA_CANARY_PLAN.md`;
do not infer a general provider timeout/expiry policy from the two 408 attempts.

PetYard's own persisted Video Asset, Product Video placement, and current
generation are the ownership authority. A Bunny TUS HEAD can report offsets,
but the earlier canary showed it does not enforce VideoId-to-URL ownership.
Provider management GET, not TUS HEAD, is the authority for whether the video
object exists. Neither alone proves that a recently completed upload cannot
still enter processing.

## Historical conservative decision matrix (before support clarification)

| Provider management GET | Fresh TUS HEAD | Local decision |
| --- | --- | --- |
| 4 with valid duration/dimensions/encodes | any | Reconcile to ready for the current generation; never replace. |
| 1, 2, or 3 | any | Keep the current Video Asset and poll; never replace based on TUS expiry. |
| 0 | complete | Keep the asset and poll; byte completion may precede encoding. |
| 0 | incomplete and original expiry still future | Refresh authorization for the same trusted resource; no new Bunny video. |
| 0 | 404 after expiry | **Ambiguous, as B demonstrated.** Keep the asset/slot; retry management reconciliation. Do not automatically delete or replace. |
| 5 or verified terminal duration failure | any | Follow the accepted terminal-failure cleanup rule; do not mistake it for a resumability failure. |
| 404 | 404 or unavailable | The provider object is absent. A generation-scoped replacement can be considered only after a fresh, current-placement check and durable old-generation cleanup/absence record. |
| 429, 5xx, timeout, malformed or mismatched identity | any | Retry observation; no destructive mutation. |

At the 24-hour abandonment deadline, an observed TUS 404 plus status 0 remains
ambiguous. The accepted cleanup behavior for an *absent* provider video must
not be generalized to that case. Administrative cancellation remains the
explicit terminal escape hatch; it is not silently triggered by a background
probe. A new canary that waits for the late-PATCH video's terminal processing
state is the next evidence gate for whether an automatic status-0 policy is
possible. The first separately approved follow-up allocation was consumed
without a complete upload; a further provider run would require its own
scope and approval, not an automatic retry.

## Implementation seam and eventual Q142 transaction

The generation/persistence design below remains applicable. Its final
status-0 evidence restriction is historical; the support clarification above
now supplies that missing provider guidance, but not completed implementation
or live acceptance of automatic recovery.

Use the existing Product Video application interface as the external seam.
Keep recovery decisions and provider orchestration inside the Videos module;
Product routes and product persistence must not call Bunny or BullMQ directly.
The provider adapter is the true external dependency, and the repository is
the persistence adapter. Tests cross the application interface and product
HTTP routes with fake Bunny/database adapters, as previously approved.

For a provider-Gone case, a future replacement must retain the Product Video
ID, position, reserved slot, visibility, and original 24-hour deadline.
Within MongoDB, reserve a new generation with a compare-and-set against the
current placement/asset and persist a recoverable setup marker. Call Bunny
outside the transaction, durably attach its returned GUID before TUS POST,
then attach the validated TUS Location to that exact generation. Adopt it
only if the marker still owns the placement; persist old-generation
deletion/absence verification in the same local transaction. On a losing
generation, compensate the newly created GUID without touching the winning
or already-ready asset. An uncertain provider create must not be blindly
retried, and existing setup recovery/sweeper obligations must remain durable.

Do not wire the replacement branch while status-0/404 can represent a
completed-but-not-yet-processed upload. No public flag or production worker
needs to be enabled to test the local decision matrix and generation races.

The application-interface regression tests now exercise stale provider
absence racing verified readiness in both orders, plus a late-ready pending
replacement after its abandonment committed. Existing compare-and-set guards
preserved the current Product Video or old ready asset as appropriate in the
fake database. These tests do not establish real MongoDB transaction behavior
or make the ambiguous status-0/404 case eligible for automatic replacement.
