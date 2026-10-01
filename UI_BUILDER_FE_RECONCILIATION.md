# Customer Home UI Builder: FE Contract Reconciliation

Status: working implementation contract, 2026-09-24. Source: `UI_BUILDER_BACKEND_SPEC.md` supplied by the frontend team. That document labels itself a **v1 proposal**; its claims about what Flutter currently renders are compatibility inputs, while its recommended storage, permissions, lifecycle, and delivery order are proposals to adapt to this Express/Mongoose backend. Nothing here authorizes deployment or changes to the live customer endpoint.

## Confirmed release boundaries

- The editor is in the **super-admin mobile app**, not the checked-in web admin tool. Backend editor routes remain super-admin-only for v1; the FE document's granular roles are a future authorization design, not a grant to ordinary admins.
- `GET /api/v1/home-layout` currently serves a legacy six-section response and its PATCH is in use. Keep both unchanged by default; switch GET only through an explicit default-off cutover flag after coordinated app rollout. The new published contract may be exposed separately for integration testing but must not silently replace the legacy response.
- The frontend reports current customer-app support for the ten built-in section types, `admin_promo`, `dynamic_section`, and five fixed navigation destinations. It does **not** report support for `widget_group`, arbitrary child trees, remote preview entry, or remotely configured chatbot FAB. Public publishing must not assume unsupported renderers work.
- Full-snapshot draft PATCH, immutable published versions, server-side validation, and app-owned pet/Prime personalization remain valid principles. Drafts and preview snapshots must never leak through the public published read.
- The user selected the full proposed backend lifecycle, including scheduled publication, previews, history/rollback, targeting, and assets. Optional review/approval remains optional per FE §4. Implement and verify each part before enabling its catalog capability; staging and production deployment are separate release decisions.

## Keep / change / remove / add relative to the paused implementation

| Area | Decision | Reason |
| --- | --- | --- |
| Domain location | Keep `src/domains/uiLayout/` and existing model/service/controller/routes/validators convention. | Matches repository structure. |
| Legacy Home API | Keep `src/domains/homeLayout/` and its mounted path unchanged. | Old clients expect `{data:{sections}}`. |
| Draft update | Keep complete replacement, change concurrency to `If-Match: "<revision>"`; support mutation-ID retry deduplication. | FE §11/§11.1, while preserving stale-write protection. |
| Contract | Replace `widget_group`/opaque `children` with allowlisted built-ins, `admin_promo`, and `dynamic_section`; validate their fields. | FE §§13-17 says current renderer supports these exact section types, while arbitrary trees are future. |
| Visibility | Remove the paused top-level `pet_types`/`prime_location` rules from v1 public content. `admin_promo.data.visibility` uses `all/logged_in/guest`. | FE §§15,24 says pet and Prime state are resolved by the app/domain, not builder targeting. |
| Navigation | Keep the five fixed destinations and stable label/icon keys; allow reorder/toggle with enabled home; remove disabled/unknown destinations at publish validation. | FE §18 and prior user choice. |
| Chatbot FAB | Store its enabled setting in drafts and immutable version history, but omit it from the v1 customer-app response and advertise `chatbot_fab_config: false` until FE adds support. | User explicitly chose to save the setting now; FE §§2,18,36 says the current app cannot use it. |
| IDs | Use UUID public layout/draft/version/section/item/asset/preview IDs, while preserving internal Mongo ObjectIds for existing user references. | FE §5, adapted to Mongoose. |
| Public payload | Add immutable `version_id`, `version_number`, `checksum`, `published_at`, sections, and navigation; checksum-derived ETag and 304. Do not expose draft metadata. | FE §12. Serve only on the new integration route until cutover. |
| Persistence | Replace singleton mutable draft with distinct draft and immutable version records plus atomic active pointer. | FE §§4-6,21-23; supports independent drafts, schedule, rollback, audit. MongoDB transaction rather than proposed SQL tables. |
| Preview | Add immutable expiring token-hash snapshot and `no-store` read, but advertise `remote_preview: false` until customer-app entry is implemented. | FE §§20,36. |
| Schedule | Add frozen scheduled snapshot, durable execution, revalidation, retry/failure observability, and cancellation. | FE §22; no in-memory timer. |
| Targeting | Add deterministic resolution only after target-header, app-version, global fallback, and overlap rules are fully validated. | FE §24. Never make Prime/pet personalization a backend layout segment. |
| Assets | Reuse an existing approved upload/media pipeline where possible; validate ready/public references. New asset endpoints need actual storage-provider integration, not placeholder URLs. | FE §26. |
| Error shape | Provide field-path machine codes; adapt to repository error middleware without accidentally changing errors for other domains. | FE §§8,19,32. |
| Catalog | Add versioned enum/field definitions and truthful capability flags. `composed_section` and configurable FAB remain disabled until client support exists. | FE §§27-28,36. |

## FE document inconsistencies to resolve in implementation/tests

- §5 says all item IDs are UUIDs, while §12's `dynamic_section` example uses `dyn-item-1`; the normative rule will be UUID for new editor writes.
- §10's blank draft has empty navigation, while §18 requires enabled home for publication. Incomplete drafts are allowed, but publication is not.
- §4 allows `scheduled` drafts, while §22 requires a frozen scheduled snapshot. Scheduling must persist a separate immutable candidate or lock the draft; autosaves must not alter the scheduled payload.
- §12's public sample contains literal promo strings, while §25 describes localized draft objects as future. V1 public values must remain literal strings; localization support needs an explicit resolver and fallback.
- §12 recommends a `private` response even though current target rules could make global reads cacheable. Use conservative private/no shared-CDN caching until targeting and `Vary` behavior are proven.
- The file calls itself a frontend flow/spec but contains numerous backend recommendations. We should not infer that Flutter already implements remote preview, FAB, custom composer, asset upload, scheduling, or dashboard Hive work.

## Acceptance gates before cutover

1. Contract fixtures for every supported section and navigation permutation; reject unknown sections/actions and empty publications.
2. Draft CRUD, autosave retry, stale revision, two-admin concurrency, and authorization tests.
3. Immutable preview/token expiry/revocation and no-cache tests; FE must add preview entry separately.
4. Atomic publish/idempotency, scheduled execution/failure preservation, history/rollback, checksum/ETag, and no-draft-leak tests.
5. Target resolution/overlap and asset/reference validation with active public catalog records.
6. Legacy `GET/PATCH /api/v1/home-layout` regression tests, then coordinated customer-app integration and explicit route cutover.
