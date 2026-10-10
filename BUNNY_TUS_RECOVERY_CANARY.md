# Bunny TUS recovery canary

Status: **approved empty-resource retry completed on 2026-09-27**. Both
temporary video objects were deleted and management GET confirmed their
absence. Original TUS expiry was observed, but mismatched-video authorization
was accepted for HEAD: this is NOT a pass for trusting client-provided URLs.
No feature flag change, deployment, or production-product edit occurred.

## Approved retry evidence (2026-09-27)

- Run marker: `e7a30a02-40c9-46dd-bde3-73025c5daaf2`; began at
  `2026-09-27T18:26:03Z`, library `754739`.
- Corrected only the isolated harness: allow an exact root-relative
  `/tusupload/<permitted ID>` Location and prefix the fixed Bunny HTTPS origin,
  then apply the existing strict absolute-URL validator. No redirects or
  arbitrary URL resolution. Fourteen local valid/invalid URL checks and the
  harness syntax check passed; the production adapter was not changed.
- Created exactly two new disposable video objects, A
  `19ea8c6b-5eda-4f84-96e3-f53817fc14b7` and B
  `a902bd11-7eaf-4430-95c2-3fbd2bd9439c`. Each empty TUS POST returned **201**
  and a valid root-relative Location. Declared length was 100 bytes each;
  **no media bytes were sent**. A used a 120-second initial authorization;
  B used 600 seconds. Application configuration was not changed.

| Probe | Actual result |
| --- | --- |
| A URL with fresh A signature, before original expiry | Valid incomplete upload, offset 0 / length 100 |
| B URL with B signature, before expiry | Valid incomplete upload, offset 0 / length 100 |
| A URL with valid B signature | Accepted as incomplete, offset 0 / length 100; no ownership rejection |
| Unallocated UUID-shaped URL with hyphens | HTTP 400; not used as missing-resource evidence |
| Unallocated 32-character URL, matching observed ID shape | HTTP 404 |
| A URL with fresh A signature after original expiry | HTTP 404; fresh authorization did not restore resource |
| B URL with fresh B signature at the same time | Still valid incomplete upload, offset 0 / length 100 |
| Management GET A and B, before and after A's expiry | Matching video GUIDs still present, status 0, length 0, storageSize 0 |
| Cleanup of A and B | Each DELETE 200, then management GET 404 |

The two resources had identical offsets/lengths, so the mismatched HEAD cannot
prove which internal resource Bunny looked up. It does prove this check did
not reject the mismatch and therefore cannot establish URL-to-video ownership.
The expiry and unallocated-path results also demonstrate that TUS 404 alone
cannot distinguish expired from never-owned URLs or mean management absence.

### Consequences and remaining gates

Local follow-up: trusted server-created/persisted resource setup is now
implemented for Product Video batches and replacements (see the V3 checkpoint
in `VIDEOS_IMPLEMENTATION_PLAN.md`). The remaining media and automatic-fallback
gates below are not satisfied by that local implementation.

- Recovery needs a trusted backend-created and persisted TUS Location bound to
  the exact asset/session generation. Do not trust client URL registration
  based only on a successful signed HEAD request. Work out durable setup and
  crash/retry handling before changing the upload-session contract.
- An expired upload resource does not delete its video object. Continue the
  management-state check plus durable cleanup before any safe replacement.
- Empty-resource expiry behavior is now observed for this library; completed
  uploads, in-flight final PATCH, encoding/processing races, and playback are
  **not tested**. Automatic expired-TUS fallback remains unwired pending these
  gates; do not delete existing media based on this diagnostic alone.
- Both exact video deletions and absence checks succeeded. Independent TUS
  absence after management deletion was not probed; do not conflate the two.
- All four feature flags remained false and `.env` was byte-for-byte unchanged.
  No product/database/application/worker/deployment changes occurred.
- Private evidence: `scripts/bunny-tus-canary/retry-2026-09-27-private.json`
  (Git-ignored, no keys or signatures). The first manifest is preserved.
  The retry harness refuses to overwrite its existing manifest, preventing
  accidental additional creates. No further provider allocation is authorized
  by this completed run.

## First attempt evidence (2026-09-27)

- Run marker: `2406e302-06d3-419c-9032-ac8515af3fed`.
- Library: `754739`; decrypted configuration valid; all four feature flags
  false. The encrypted `.env` file hash was unchanged throughout the run.
- Two disposable management video objects were created successfully:
  A `87e79f59-0dc6-4fd2-b6da-74a754c535f0` and
  B `3ec365cb-0cfb-45e8-a5f3-094658f268bb`.
- A's empty TUS creation returned **201** with a root-relative Location of
  shape `/tusupload/<32-character ID>`. It had no query or fragment; resolving
  it against the fixed creation endpoint produces the expected HTTPS Bunny
  origin and permitted path. The full resource URL is intentionally omitted.
- The harness passed the raw Location to an absolute-URL gate, so it stopped
  before HEAD probes. B's TUS resource was not created. This is a canary
  harness normalization gap, not evidence that Bunny rejected upload access
  or that the adapter's absolute-URL security boundary should be relaxed.
- Both exact video DELETE requests returned **200**; each following management
  GET returned **404**, at approximately `2026-09-27T18:20:04Z`.
  No media bytes were sent. TUS-resource deletion itself was not separately
  observed; management absence must not be reported as that observation.
- No create retry, customer/product database access, application/worker
  startup, environment edit, or deployment occurred.
- Local operational harness: `scripts/bunnyTusRecoveryCanary.mjs`.
  Private cleanup manifest: `scripts/bunny-tus-canary/private.json`.
  Both paths are Git-ignored; the manifest contains IDs and the private
  Location, but no keys or signatures. Preserve it as cleanup evidence.

### First-attempt handoff (resolved by the approved retry above)

Normalize the provider-returned root-relative Location against the fixed
creation endpoint **before** invoking the existing strict absolute-URL
validator. Allow only the exact root-relative `/tusupload/<permitted ID>`
shape or an already validated absolute URL; do not permit protocol-relative
hosts, traversal, queries, fragments, credentials, or redirects. Relative
Location values are permitted by the
[TUS creation specification](https://tus.io/protocols/resumable-upload#creation).
Keep the production adapter boundary strict; no production change is required
merely to normalize a provider response in this harness.

The first approved two-video allocation was consumed and cleaned up. The user
subsequently approved the separate two-video retry recorded above. Its separate
manifest preserves the first attempt's evidence.

## Why this gate exists

Bunny distinguishes a video object from its resumable TUS upload resource.
Fresh authorization does not extend the latter's original expiry. Bunny says
an incomplete resource expires at its initial authorization deadline or after
roughly 48 hours of inactivity, whichever comes first, returning HTTP 404.
Authorization is checked when each request starts, not throughout an active
PATCH. [Bunny TUS documentation](https://bunny.net/docs/stream/tus-resumable-uploads)

HEAD provides offset/length for resume; it does not prove playable video
readiness. URL structure and authentication are provider-specific.
[TUS protocol](https://tus.io/protocols/resumable-upload)

Therefore neither a client-reported 404 nor a missing arbitrary upload URL is
sufficient to delete or replace the owned video object. We must establish
URL ownership while the upload exists, and protect already-uploaded/processing
media when considering fallback later.

## Scope to approve

- Create exactly two clearly labelled, disposable video objects in the
  configured library, unrelated to Product/Reel records.
- Create empty TUS resources for them (declared small byte lengths, no customer
  media); use short-lived authorization to exercise expiry quickly. Short TTLs
  are for this controlled test only, not a change to application defaults.
- Send HEAD requests using correct and deliberately mismatched video IDs, then
  compare fresh-signature behavior before/after the original resource expiry.
- GET those exact video objects to record their authoritative state alongside
  the TUS response. Do not infer a video GET 404 from a TUS HEAD 404.
- Delete only the two captured canary GUIDs, verify absence, and report cleanup.
  No library-wide deletion or speculative search-based deletion is permitted.

## Preconditions and safe execution

1. Confirm configured library identity without printing credentials. Keep all
   four feature flags unchanged. Do not start the production application/worker.
2. Generate a unique run marker. Capture each returned GUID immediately in a
   local untracked cleanup manifest; it must contain no API key/signature.
   Never retry an uncertain create blindly: the duplicate/orphan risk must be
   reconciled before continuing.
3. Capture the exact Location returned by TUS creation, privately. The new
   adapter currently accepts only
   `https://video.bunnycdn.com/tusupload/<alphanumeric, underscore, hyphen ID>`.
   That is a restrictive policy, not a claim that the actual Location format
   has been observed. If Bunny returns another format, stop and inspect it;
   do not weaken the URL policy or follow redirects automatically.
4. Use fresh bounded signatures for every HEAD. Never send the Stream API key
   to a TUS resource, log request headers, or include full resource URLs in a
   user-facing transcript. Do not hold a blocking sleep longer than 60 seconds.
5. Cleanup runs even on an assertion failure. If deletion fails/has an uncertain
   outcome, retain the exact cleanup identifiers and report the remaining work.

## Required observations

| Probe | Evidence needed before fallback implementation |
| --- | --- |
| Valid URL and owning video signature | HEAD 200/204, TUS version, sane offset/length |
| Video A URL signed for Video B | Must not report A's upload as valid for B; record actual rejection |
| Unallocated/altered URL with valid signature | Establish why 404 alone cannot prove ownership or expiry |
| Re-sign before original resource expiry | Same URL can be inspected/resumed; original expiry is not extended |
| Fresh signature after original expiry | Record HEAD response and separate management GET state |
| Cleanup | Both exact video GUIDs accepted for deletion and absence confirmed |

If ownership is not enforced by Bunny HEAD, later fallback must use a trusted
server-created/persisted TUS Location instead of accepting arbitrary client
URLs. Even if ownership is enforced, registration must happen while the
resource is live, before relying on its later absence.

This empty-resource canary does **not** prove completed-upload or in-flight
PATCH behavior. A subsequent bounded media canary must cover upload completion
near expiry, the processing-state mapping, and late final chunks before any
automatic fallback or general abandonment of existing resources is enabled.

## Implementation handoff after results

Keep same placement ID, reserved position, visibility, and original 24-hour
deadline. Bind recovery idempotency to the exact asset/session generation;
check current ownership and processing state again in the commit transaction.
Persist old-resource cleanup atomically with adoption of the new asset;
compensate any newly created resource if adoption loses a cancellation,
replacement, or product-deletion race. Existing ready replacement media stays
untouched. Provider calls remain outside Mongo transactions.

Use `inspectTusUpload` as an observation, not a deletion authorization. No route
currently exposes it, and no recovery state mutation is wired to its result.
