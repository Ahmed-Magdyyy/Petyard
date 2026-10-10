# PetYard completed and in-flight TUS media canary

Status: **completed and cleaned up** (2026-09-28 local / 2026-09-27 UTC).
This was a separately approved provider-write scope from the earlier
empty-resource canary. Exactly two synthetic-video objects were created;
neither was connected to products, reels, the application, or a worker.

## V3.10 separately approved one-video repeat (2026-10-02 local)

The user approved one additional disposable synthetic video to observe a final
PATCH across the original authorization expiry and its subsequent processing.
This is a new bounded scope, not reuse of a consumed allocation. At this
checkpoint the approved run is complete and cleaned up, but inconclusive for
late-completion processing. It used library 754739 and the same recorded
7,062-byte MP4; allocate at most once, observe processing for at most three
minutes after successful byte completion, then delete only the captured GUID
and confirm management GET 404. No automatic allocation retry is authorized.

The ignored harness was updated for the current provider imports and a fresh
manifest at
`scripts/bunny-tus-late-processing-canary/v3-10-approved-repeat-2026-10-02/private.json`.
The earlier manifest remains untouched. Small middle-body chunks keep the final
PATCH active, with its last bytes scheduled at expiry + 2 seconds; this avoids
repeating the previous idle gap, without assuming that gap caused the prior 408.
An early response/error cancels further body writes, PATCH has an absolute
timeout, and management request timeouts are bounded by the observation deadline.
Preflight confirmed the exact media/hash, configured library, four flags off and
absent fresh manifest. A private environment hash is retained for comparison.

This approval permits no Product/Reel/database records, worker startup, flag,
environment or dashboard change. A failed/incomplete upload or observation
timeout remains inconclusive. Even a terminal result does not establish a
provider-wide 24-hour processing guarantee or authorize automatic abandonment.

Initial evidence: the single create returned captured GUID
`c938864b-4d47-4958-9255-f5bd82554196` at `2026-10-02T00:01:57.712Z`.
The partial PATCH returned 204 with offset 3,531/7,062; HEAD confirmed incomplete
and management GET reported status 0. The original test-only expiry was
`2026-10-02T00:03:57Z`.

- Final PATCH first-byte queueing occurred at `00:03:52.059Z`, and TLS connection
  at `00:03:52.197Z`, before the original expiry. Six 128-byte middle chunks were
  queued at roughly one-second intervals through `00:03:58.101Z`. These are
  client queueing timestamps, not independently measured server receipt times.
- Bunny returned **408** at `00:03:58.211Z`, before the scheduled last bytes at
  expiry + 2 seconds. The response contained no completed upload offset. The
  harness canceled subsequent writes immediately; the manifest contains no
  final-byte queueing event. There was no successful complete-upload
  acknowledgement, so terminal processing observation was not reached.
- Exact captured-GUID DELETE returned **200** at `00:03:58.639Z`; management GET
  returned **404** at `00:03:58.844Z`. A further read-only GET after the canceled
  timer's scheduled deadline returned **404** at `00:04:40.781Z`.
- The finish command exited 1 at `CANARY_PATCH_RESULT`, accurately recording
  the incomplete test outcome; the separate post-timer verification exited 0.
  `.env` hash and the earlier follow-up manifest hash were unchanged. The four
  flags stayed false, with no Product/Reel/database/Redis/worker/dashboard work.
  Harness syntax and scoped document checks passed; the existing 492-test
  backend result remains applicable to unchanged source/tests, not fresh live
  acceptance evidence.

This attempt shows another 408 despite intermediate client writes, not a general
rule about why Bunny rejected the request. It cannot settle B's earlier accepted
late-completion outcome or establish a 24-hour abandonment policy. V3.10 and
automatic Q142 fallback remain gated. This one allocation is consumed and
confirmed absent; no repeat allocation is authorized. Preserve the manifest and
earlier evidence, and do not continue repeating live canaries without a distinct
evidence hypothesis and separately approved scope.

## One-video late-processing follow-up (2026-09-28 local)

The user separately approved exactly one more synthetic-video object to wait
for late-PATCH processing. This one-resource attempt did **not** produce a
complete upload, so it cannot resolve B's eventual status-0 outcome.

- One `DELETE-ME` video was created in library `754739`, GUID
  `e948184c-9a34-4333-ad56-0e763ac9f5a1`. The same 7,062-byte synthetic
  MP4 was used; no Product/Reel records, worker, flag, or `.env` changes.
- The initial partial PATCH returned **204** with offset **3,531 / 7,062**.
  TUS HEAD reported `incomplete`; management GET reported status 0.
- The final PATCH was opened locally at `23:32:53.029Z`, and its TLS
  connection completed at `23:32:53.178Z`, ahead of the original
  `23:32:58Z` expiry. One body byte was queued at request start. Bunny
  returned **HTTP 408** at `23:32:58.586Z`, before the scheduled final
  bytes at expiry + 2 seconds. No full-offset response was obtained, and
  the video was not polled to a processing terminal state.
- The harness had already scheduled a delayed `req.end`; that callback ran
  at `23:33:00.003Z` after the 408 and cleanup. The callback log cannot
  establish delivery to Bunny. The ignored harness was then corrected to
  cancel pending writes when a response/error arrives; no rerun was made.
- Exact-GUID DELETE returned **200**, management GET returned **404** at
  `23:32:59Z`, and an additional read-only management GET after the late
  callback again returned **404** at `23:33:34Z`. The private ignored
  manifest is `scripts/bunny-tus-late-processing-canary/private.json`.
  `.env` was byte-for-byte unchanged. This approval's one allocation is
  consumed and cleaned up; no retry is implied.

The follow-up shows a different timing outcome from B's 204/full-offset
response. It is not proof that Bunny always cuts off an in-flight PATCH at
expiry, nor proof that B would or would not later process. Q142 automatic
replacement remains disabled for ambiguous status 0 plus TUS 404.

## Actual run and bounded results

- Source: locally generated, non-customer MP4, 2.0721 seconds, 320 x 240,
  7,062 bytes, SHA-256
  `38769e110542ce0f0d0fbe813b6eaf26de7acb20eabb9abdc5962d6367a5dc1c`.
  It lives at `scripts/bunny-tus-media-canary/synthetic-two-second.mp4`.
  The ignored generator is `scripts/generateSyntheticCanaryVideo.mjs`.
- Library `754739`; all four video flags false before writes; `.env` remained
  byte-for-byte unchanged. Run evidence and exact GUIDs are in the private,
  Git-ignored `scripts/bunny-tus-media-canary/private.json`. No keys,
  signatures, customer media, product records, or public playback were used.
- A: full PATCH returned **204**, offset **7,062 / 7,062** at
  `22:59:46Z`; immediate HEAD reported `complete`. Management GET reached
  **status 4**, length **2 seconds**, available resolution `240p` at
  `23:00:17Z`. After its initial expiry (`23:01:45Z`), a fresh-signed HEAD
  still reported `complete`, and management GET still showed status 4.
- B: first PATCH returned **204**, offset **3,531 / 7,062**; HEAD reported
  `incomplete`. The final PATCH began locally at `23:01:43.009Z` and wrote
  its first body byte before the initial `23:01:46Z` expiry. The last
  3,530 bytes were sent at `23:01:48.007Z`, after expiry. Bunny responded
  **204**, offset **7,062 / 7,062**, at `23:01:48.144Z`. A fresh-signed
  HEAD then returned `not_found`, while management GET still found B with
  **status 0**. This establishes accepted TUS bytes and a diverging later
  TUS lookup, **not** that B became playable. Because no packet-level/server
  timing was captured, the precise instant Bunny checked authorization is
  inferred from the successful response, not directly observed.
- Both exact Bunny video DELETE requests returned **200**; following
  management GET returned **404** for each at about `23:01:50Z`.
  No resource remains known. The earlier empty-resource manifests were
  untouched. Encoding/storage charges may still appear on the account.

The key distinction is that an originally expired resource can still HEAD as
`complete` for A, while B's late-completion PATCH returned 204 but its HEAD
then returned 404 and its management status had not advanced from 0 before
cleanup. Neither a TUS 404 nor a successful PATCH alone is safe proof for
deleting or replacing the provider video. This run does not enable Q142
automatic fallback; a separate generation-safe design and further evidence
for B's eventual processing behavior would be needed.

## Why this is the next gate

The [empty-resource run](BUNNY_TUS_RECOVERY_CANARY.md) established that a
fresh signature cannot revive an expired incomplete TUS resource, that TUS
HEAD accepts a mismatched `VideoId`, and that TUS 404 does not imply the Bunny
video object is absent. The backend now creates and persists a trusted TUS
Location, but automatic expired-resource replacement remains off. This run
probed completed upload after original expiry and a final PATCH locally
spanning expiry; the bounded observations above do not settle every recovery
or processing race.

[Bunny's TUS documentation](https://bunny.net/docs/stream/tus-resumable-uploads)
says authorization is checked when a PATCH starts and not rechecked while it
streams. This is consistent with B's accepted PATCH, but the exact server
authentication instant was not independently instrumented. The [TUS protocol](https://tus.io/protocols/resumable-upload)
requires a PATCH's offset to match the server offset and a successful PATCH to
return 204 with an updated offset. Management video status and readiness must
be observed separately.

## Approved bounded scope (executed as above)

- Use exactly **two** new, clearly `DELETE-ME`-labelled video objects in the
  existing library `754739`, disconnected from Product/Reel records. No
  dashboard configuration or `.env`/flag edits.
- Use one disposable, non-customer MP4, at most 1 MiB, uploaded at most once
  per object. The user requested a generated two-second file; it was made
  locally from a synthetic canvas with no input media, camera, or microphone.
- A: create a TUS resource with a short test-only original expiry; complete
  its upload well before that expiry. Observe provider GET until ready/failed
  or a bounded timeout. After the original expiry, HEAD the exact saved TUS
  URL with fresh authorization and GET the exact video again. A `404` on TUS
  after byte completion must **not** authorize deletion of a processing/ready
  video.
- B: create a separate TUS resource; send an initial partial PATCH. Start its
  final PATCH just before the resource's original expiry and control the
  request body so its last bytes arrive after that expiry. Record local
  send-start, final-byte, response, and provider GET times. Preserve the
  request's original authorization; do not re-sign mid-PATCH. Then inspect
  HEAD with a fresh signature and GET the video. If buffering or timing means
  the request did not actually span the deadline, mark this case inconclusive
  rather than claiming Bunny's in-flight behavior was confirmed.
- No browser/player/analytics checks, public playback, or automatic fallback
  mutations are included in this canary. A separate mobile/playback gate
  remains.
- Storage, encoding, and transfer may incur small charges even if both
  videos are deleted promptly. Actual billing depends on this library's
  settings; do not assume a zero-cost test.

## Safety and evidence protocol

1. Before writes, validate the supplied MP4 path by exact path, type, and
   size; verify the configured library, four flags off, and no existing
   manifest for this run. Keep the production app/worker stopped. Do not print
   API keys, signed headers, complete TUS Locations, or local media bytes.
2. Generate a unique marker and save every returned provider GUID immediately
   to a new Git-ignored run-specific cleanup manifest. Store the exact TUS
   Location privately after strict same-origin/path validation. Do not retry
   an uncertain create POST: reconcile from known GUIDs first.
3. Use fixed Bunny endpoints, signed TUS headers only on TUS requests,
   `redirect: error`, finite per-request/total timeouts, and no management
   `AccessKey` on POST/HEAD/PATCH to `/tusupload`. Use `Upload-Metadata` with
   both `filetype` and `title` as Bunny requires. Record only statuses, offsets,
   bytes, timestamps, and management fields in redacted observations.
4. After any failure or inconclusive result, delete **only** the exact captured
   canary GUIDs. Check management GET returns 404 for each. If a deletion is
   rejected/uncertain, retain the manifest and report the exact remaining
   cleanup target; never hide an orphan or do broad library deletion.
5. Keep each wait under 60 seconds and provide progress updates while the
   test is running. Leave the first two empty-resource manifests untouched.

## Decision gate after results

Only if the observations distinguish incomplete, complete, in-flight, and
processing media reliably may Q142 automatic fallback be designed at the
generation-scoped Product Video application/repository seam. It must preserve
the Product Video ID, slot, position, and original 24-hour deadline; commit
replacement adoption and old-GUID cleanup durably; and compensate a losing
creation without touching ready or newer generations. A non-conclusive media
canary does not justify a destructive fallback.
