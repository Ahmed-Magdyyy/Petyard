# PetYard Reel orphan discovery acceptance plan

Status: V5.15's positive-match provider acceptance passed on 2026-10-02 (Africa/Cairo), after the timestamp correction and a separately approved one-empty-video repeat. Both test resources are confirmed removed. The two allocation scopes are consumed; no further allocation or automatic enablement is approved. Real MongoDB/Redis/worker and release acceptance remain separate gates.
Scope: V5.15. Automatic recovery remains disabled and unwired.

## Proof needed

The original evidence gap was a positive exact-marker match in the configured
Bunny library and integrated local adoption/worker cleanup. Both evidence sets
are now recorded below. They do not prove live MongoDB/Redis or worker behavior.

Keep two separate evidence sets:

1. Local integration through discovery/recovery, the real transactional recovery
   repository and provider runtime, using fake MongoDB, Bunny and queue adapters.
   The user confirmed these boundaries. All eight tests in
   `test/domains/videos/reels/reelOrphanRecoveryIntegration.test.js` passed;
   the full Videos suite passed 469/469. No production implementation change
   was needed. The fake transaction fixture serializes transactions; it cannot
   prove live MongoDB write-conflict handling or unique-index enforcement.
2. A separately approved, one-resource live provider canary. This does not prove
   real MongoDB transactions, Redis, standalone worker execution or rollout readiness.

## Local acceptance cases

- An exact, empty, untracked candidate is adopted once, records durable cleanup
  before queue dispatch, and is removed through the existing provider worker.
- Repeated discovery cannot create another cleanup obligation for the same session.
- A tracked GUID or a session claimed between inspection and commit is not adopted.
- Operation persistence failure rolls back adoption; queue loss remains sweepable.
- The deleted editorial owner is not needed for adoption or cleanup; its failed
  upload session marker survives for this reason.
- Incomplete/duplicate searches, mismatched identity/library/time, uploaded bytes,
  non-empty resolutions or non-zero processing metadata never authorize cleanup.

Do not change product code merely to manufacture a failing test. If a regression
is discovered, add a focused failing test before making the narrow correction.

## Live scope to approve separately

Create at most one empty Bunny video in the currently configured library
(last recorded library ID: `754739`; verify the configured ID before any write).
Use one newly generated ObjectId in the exact title
`petyard-reel-session:<24-character lowercase ObjectId>`.

No video bytes, TUS resources, playback grants, product/editorial records,
production MongoDB/Redis writes, normal worker startup, flag changes, library
settings, key rotations, package installation, commits or deployment are allowed.
This is a new approval scope; older TUS canary approvals do not cover it.

The existing adapter sends `page=1`, `itemsPerPage=10` and an exact marker as the
search query. Bunny documents these list parameters and the list response fields
in [List Videos](https://bunny.net/docs/api-reference/stream/manage-videos/list-videos).
Use [Create Video](https://bunny.net/docs/api-reference/stream/manage-videos/create-video)
only once and retain its returned GUID independently for cleanup. The live
inspection must discover that same GUID without receiving it as a candidate hint.

## Procedure and stopping conditions

1. Check the current configuration without printing credentials. Preserve `.env`
   and flags. Prepare a private, ignored manifest before the create request.
2. Record the marker and request timestamps, then issue one create request.
   Persist the returned GUID before proceeding. Never retry an uncertain create.
3. Observe the bounded marker search and exact-GUID GET. Allow at most six search
   attempts over one minute; do not loosen the page-completeness or identity guards
   to obtain success. Capture only sanitized timestamps, IDs and relevant metadata.
4. Supply a synthetic failed-session context to the existing read-only `inspect`
   interface, with honest creation/failure timestamps. Its result must be
   `candidate` with exactly the manifest GUID. Missing/null metadata is not silently
   treated as zero, and `no_match_observed` is not proof of absence.
5. Delete only the manifest GUID, after an immediate GET confirms its exact marker
   and expected library. Never delete another search result. Verify authoritative
   GET 404 afterward. [Bunny deletion is irreversible and lookup removal does not
   promise immediate playback revocation](https://bunny.net/docs/api-reference/stream/manage-videos/delete-video).
6. If creation or cleanup is uncertain, stop further allocations and retain the
   manifest as an unresolved obligation. Search-only evidence must not authorize
   deletion of an unknown object. Report the exact unresolved state and request
   direction rather than consuming another allocation.

This provider-only canary does not use `.recover()` with production persistence.
Actual adoption/worker behavior is verified separately at the approved local
boundaries, and later against explicitly approved isolated MongoDB/Redis targets.

## Completion record

Record the actual candidate result, relevant metadata, exact cleanup response and
GET-404 evidence. Keep the live acceptance checkbox unchecked until these exist.
Even after this proof, enabling automatic recovery requires a separate wiring and
rollout decision; no successful canary changes flags or removes the upload guard.

### Approved harness preparation (2026-10-02)

- Prepared the ignored operational harness `scripts/bunnyReelOrphanCanary.mjs`
  and verified that its private manifest path is also ignored. It uses the existing
  Bunny adapter and read-only discovery inspection, not production persistence.
- Syntax and ten local safety checks passed without network calls. Preflight
  confirmed library `754739` and all four feature flags disabled, without printing
  credentials or changing `.env`.
- The harness refuses another allocation when its manifest exists. Its HTTP guard
  permits only the single exact-marker POST, bounded marker searches, exact-GUID
  reads and one exact-GUID DELETE. Cleanup checks marker/library identity again
  immediately before deletion and retains uncertain outcomes in the manifest.

### Live result and blocker (2026-10-02)

- Independent read-only safety review found no actionable findings. The approved
  run used one POST, one marker search, four exact-GUID GETs and one DELETE. It
  uploaded no bytes and did not use TUS, MongoDB, Redis or a worker.
- Created GUID `ed494595-81ed-4e64-aba5-31f2fa69c97e` in library `754739`, with
  marker `petyard-reel-session:bf5e53c69e12dac3ae09f07f`. The real inspection
  returned `requires_review`, not `candidate`. No guard was weakened to pass it.
- Exact metadata had status, length, storage size and encode progress all `0`,
  resolutions `null`, and matching GUID/title/library. `dateUploaded` was
  `2026-10-01T22:36:46.149`, without a timezone suffix. Session creation and
  synthetic failure timestamps were `2026-10-01T22:36:45.899Z` and
  `2026-10-01T22:36:46.230Z`.
- Offline diagnosis confirmed that `Date.parse` on this Cairo host converted the
  provider timestamp to `2026-10-01T19:36:46.149Z`: three hours earlier, outside
  the five-minute guard. Interpreting the same value as UTC puts it 250 ms after
  creation. The latter is evidence consistent with UTC, not a blanket guarantee
  about arbitrary timezone-less dates. The [official GET example](https://bunny.net/docs/api-reference/stream/manage-videos/get-video)
  uses a `Z` suffix; this actual response omitted it.
- Cleanup independently rechecked exact GUID/title/library. Bunny accepted DELETE
  with HTTP `200`; the immediate exact-GUID GET returned `404`. This empty test
  resource was permanently removed; the private manifest retains its evidence.
- The harness exited `1` because candidate acceptance failed, despite cleanup
  succeeding. `.env` remained byte-for-byte unchanged and all flags stayed off.
  Production implementation was not edited. The prior 469-test result remains
  local evidence, not proof that this live gate passed.
- Next: correct provider timestamp handling with a regression using this recorded
  response under non-UTC and UTC host timezones, preserving strict time/identity
  guards. A subsequent live allocation requires new explicit approval. Recovery
  remains default-off and unwired; V5.15.3 and its parent remain unchecked.

### Local timestamp correction (2026-10-02)

- The user correctly identified the Cairo UTC+3 offset. Inspection confirmed
  `src/shared/utils/egyptTimezone.js` is an outgoing Express JSON replacer, not
  part of incoming Bunny parsing or internal cleanup comparisons. It remains
  unchanged; no global timezone or stored timestamp conversion was introduced.
- The recorded-response regression failed first with `requires_review`. A
  private parser in the existing `reelOrphanDiscovery.js` now interprets the
  observed unzoned ISO-shaped Bunny dates as UTC and preserves explicit `Z` or
  numeric offsets. This is a provider-specific interpretation supported by the
  captured response and the official UTC example, not a general policy for all
  unzoned dates. Unsupported formats, missing values and non-finite dates fail
  closed; the existing time, identity, completeness and empty-resource guards
  remain unchanged.
- Independent review identified JavaScript's calendar rollover behavior. Added
  a failing regression demonstrating non-leap-year February 29 becoming March 1
  inside the creation window. The parser now also requires the supplied calendar
  and time components to round-trip unchanged before applying an explicit offset.
  Corrective review found no remaining actionable findings.
- Four new integration tests use the already confirmed discovery/repository/
  provider boundaries. The captured response is replayed through the real Bunny
  adapter with fake HTTP and the real recovery repository with fake MongoDB;
  there are no live provider calls or database writes.
- Focused discovery, integration and adapter tests: **50 passed, 0 failed** under
  both `Africa/Cairo` and `UTC`. Full Videos suite: **473 passed, 0 failed**.
  Source/test syntax, five touched-file whitespace checks and tracked
  `git diff --check` passed. Test-only timezone overrides were restored.
- `.env` still matches its pre-canary hash. Flags and automatic recovery remain
  disabled/unwired. The historical failed live result is not overwritten or
  promoted to a pass. Next is a separately approved one-empty-video repeat using
  a new manifest while preserving this consumed run's evidence.

### Approved repeat: positive-match and exact cleanup passed (2026-10-02)

- The user explicitly approved another one-empty-video check and exact cleanup
  after the local timestamp correction. Reused the reviewed harness, changing
  only its manifest and temporary filenames to
  `scripts/bunny-reel-orphan-canary/retry-after-timezone-fix-private.json` and its
  `.tmp` sibling. Preserved the first failed run's manifest without modification.
  The harness and new manifest remain ignored by Git.
- Syntax, ten zero-network safety checks and fresh preflight passed. The
  configured library was still `754739`, with all four feature flags false.
- Created exactly one empty video, GUID `1c97601a-63b2-4aa4-911b-1bd79845a6cc`,
  with marker `petyard-reel-session:f58d00595d7c2b4365eaeecd`. At
  `2026-10-01T22:53:51.042Z`, the real read-only inspection returned `candidate`
  with that exact independently recorded GUID on its first search attempt.
- Exact-GUID GET metadata had `dateUploaded: 2026-10-01T22:53:50.654` without a
  timezone suffix, matching title/library/GUID, zero status/length/storage/encode
  progress, and null resolutions. The corrected parser passed the original
  identity, completeness, time-window and empty-resource guards without relaxing
  them. Inspection received no GUID hint and used only synthetic failed-session
  context; this was not a production database ownership check.
- Cleanup rechecked the exact title/library/GUID immediately before deletion.
  Bunny accepted DELETE with HTTP `200` at `2026-10-01T22:53:51.381Z`; exact-GUID
  GET returned `404` at `2026-10-01T22:53:51.447Z`. The sole empty test resource
  is permanently removed and has no unresolved cleanup obligation.
- Harness exit `0`; one POST, one search, four GETs and one DELETE. No uploaded
  media, TUS resources, production MongoDB/Redis writes, worker startup, flag or
  library-setting changes. `.env` remained byte-for-byte unchanged.
- V5.15.3 and the narrow V5.15 validation task are now checked. Automatic recovery
  remains disabled and unwired; live MongoDB transactions/index races, Redis and
  standalone workers remain under their existing acceptance gates. No deployment
  or public/administrative feature enablement is implied. The full 473-test local
  result remains current because production and test code were unchanged by this
  provider-only repeat; it was not rerun unnecessarily.
