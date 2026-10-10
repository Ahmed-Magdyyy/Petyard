---
status: accepted
---

# Use durable Video Provider Operations with BullMQ execution

PetYard records every asynchronous or retryable Bunny Stream reconciliation
and cleanup obligation in MongoDB before relying on background execution.
BullMQ provides prompt processing through a dedicated `video-provider` queue,
using the operation ID as the job ID, while an atomic MongoDB lease provides
the correctness boundary and a database sweeper recovers missed enqueueing,
Redis outages, expired leases, and worker crashes.

Initial Bunny video creation and TUS authorization remain request-coupled so
the upload-session endpoint can return usable credentials immediately. Any
partial or uncertain creation persists compensating cleanup for BullMQ and the
sweeper. Product code calls the Videos application service and does not depend
directly on Bunny or BullMQ.
