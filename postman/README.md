# Petyard Videos Postman collection

The [Videos collection](https://www.postman.com/collections/15026104-e88a831c-39a4-4bfa-9836-ac090af89e30) belongs to the Petyard workspace. The JSON file is a portable Collection v2.1 backup. Its synthetic examples describe the implemented contract; they are not captured live responses.

Coverage: all 53 frontend Videos routes, the signed provider webhook, two related Products gallery requests, and two existing-resource TUS helpers. Separate YouTube/Reel metadata and analytics variants produce 62 requests with 354 saved examples.

The workspace is public. Collection variables contain only placeholders and fabricated IDs. Set `BASE_URL`, user/staff tokens, resource URLs, temporary upload headers, and webhook signatures in local-only environment values or Postman Vault. Do not synchronize credentials into collection values. No request or provider allocation is executed by importing this collection.

Use the existing `BASE_URL` environment convention. Customer requests default to a stable guest header. Disable `x-guest-id` for an anonymous read, or select Bearer Token in the request Authorization tab and set `{{user_token}}` for a user identity. Staff requests already select their appropriate bearer variable. Optional query entries are disabled until selected. Enable `kind` and `status=draft` together for the draft workspace; enable report `from` and `to` together. Choose a local cover file for multipart, and a correct byte chunk for binary TUS PATCH. Postman does not seek/slice a full file automatically. Keep idempotency keys and the original actor/file unchanged for retries.

The complete internal frontend handoff remains in [VIDEOS_FRONTEND_HANDOFF.md](../VIDEOS_FRONTEND_HANDOFF.md). Public Postman documentation contains API contracts and field dictionaries, with internal source references and acceptance implementation details excluded.

Cache headers depend on where an error occurs. Authentication, role checks, rate limiting, and some request parsers run before the controller; other controllers set `Cache-Control` only after a successful service call. Error examples follow those processing phases. Treat private application data as private even when an early error omits a cache header. Missing user/guest credentials can use the shared error envelope with an empty `error` array, so use HTTP status before checking an optional domain code.

Run the local contract check from the repository root:

```powershell
node postman/check-videos-collection.mjs
```

It checks route and query coverage, variable references, request bodies against backend validators, response JSON/envelopes, all event shapes, and the validated 17,100 ms native watch example with one qualified view. It performs no HTTP requests, database writes, provider allocations, or notification sends. Full frontend/browser/device integration and deployed webhook/worker acceptance remain separate.

Verified on 2026-10-10: the local contract checker passed, and a full read-back of the saved Postman collection matched all 62 requests and 354 response examples. The comparison checked folder structure, descriptions, methods, URLs, headers, query defaults, authorization, JSON bodies, multipart fields, response status/body/headers, saved request context, and variable values. This verifies the stored documentation and examples; it is not a live endpoint or frontend integration test.

The subsequent field-provenance audit corrected the draft-position success example to `{data:{videoId,draftPosition,revision}}`; it is a summary, not a full Video. The checker now compares that example against the actual editorial service result with an isolated repository stub. The corrected example and API-only editorial folder description were read back successfully from Postman. The handoff additionally documents active-generation session identity, browser transport constraints, and field origin/reuse/storage rules. Its checks cover all 53 frontend routes, 31 editorial schema field names, and 108 distinct response-example field names. Field-name coverage supplements source review; it does not independently prove every semantic rule or a live frontend integration.
