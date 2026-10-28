# Assistant module

The assistant contains two separate flows: customer pet-care chat and private
admin business chat. They share persistence, allowance accounting and provider
transport. This directory groups their implementations by responsibility without
changing the existing HTTP contracts, stored records or worker transitions.

## Entry points

- `assistant.routes.js` mounts customer, review and usage endpoints, and the
  private admin router. The application imports this router directly.
- `assistant.body.js` supplies the request-body and rate-limit handling used by
  the application server.
- `assistant.runtime.js` drains queued customer and admin work. The standalone
  process remains `src/workers/assistant.worker.js`.

## Responsibility map

| Directory | Owns |
| --- | --- |
| `customer/` | Customer use cases, pet context and subject selection, memory, dietary warnings, reply policy, reviewed knowledge retrieval, and customer worker preparation/completion/recovery. |
| `admin/` | Private business chat, analytics access, planner schema/context/policy, report execution, retained cards, rendering, and admin worker recovery. |
| `products/` | Search intent/binding, classification/safety, legacy attributes, same-offer matching, bounded reads, and public snapshot validation/rendering. |
| `review/` | Retained observations, suspected-abuse candidates, dismissals, and review-notification publication/currentness. |
| `reporting/` | Usage aggregation and the retained topic taxonomy. |
| `shared/` | Models, transactional admission and settlement, configuration and billing, purpose isolation, attempt recording, validation, DTOs, and safe errors. |
| `providers/` | Approved model profiles, adapter selection, provider contract, OpenAI transport, and deterministic fake transport. |

Files keep their existing names and exports. Import an implementation directly
from its owning directory; there are no compatibility wrappers or new barrels.
Tests remain under `test/domains/assistant/` and use the same implementations.

## Dependency directions

The root router calls customer use cases and the admin router. The root runtime
dispatches to customer and admin workers. Those implementations use shared
persistence/configuration, provider adapters and their own policy/context files.
Customer preparation also uses product-search intent, reporting topics and review
alerts. Review notifications are consumed directly by the notification outbox
worker. Catalog reads reuse the existing product and fulfillment implementations;
admin analytics reuse the existing analytics implementations.

These folders record current responsibility, rather than impose a new strict
layering rule. In particular, shared configuration reads customer prompt and
catalog-policy constants; shared models use admin-plan and topic constants; and
the customer use-case module preserves its review/reporting re-exports. These
existing dependencies were retained to keep this refactor behavior-preserving.
Provider adapters remain independent of HTTP routes and domain persistence.

## Product-search preparation boundary

`customer/assistant.worker.service.js` calls `prepareProductSearch` only when
`productSearchEnabled` is explicitly true in server policy and admission saved a
`catalogContext`. Both default closed; no configuration was activated. Context
availability and metadata reflect these gates. Unsupported search output is
rejected; exact constraints never fall back to a loose lookup. Completion
rechecks owned binding/source and saves the bounded public snapshot with reply,
same-turn warning and settlement in the existing transaction. History/polling
project the same saved snapshot; raw sources and bindings stay private.

Public activation, native query/transaction acceptance and Flutter integration
remain separate work. See the root assistant status and product-search contracts
for their current scope and acceptance conditions.

## Verification boundary

The structural change is checked with the same selected unit and synthetic
loopback HTTP tests before and after the moves, relative-path resolution, syntax
checks, and comparison against saved source content allowing only path rewrites.
MongoDB suites, live providers and deployment acceptance are separate checks and
are not established by these local results.
