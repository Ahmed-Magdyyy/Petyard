import assert from "node:assert/strict";
import test from "node:test";

import { enqueueVideoProviderOperation } from "../../../../src/domains/videos/provider/videoProvider.queue.js";

test("a queued Video Provider Operation carries only its durable ID", async () => {
  const jobs = [];
  const operationId = "507f1f77bcf86cd799439011";
  const queue = {
    async add(name, data, options) {
      jobs.push({ name, data, options });
      return { id: options.jobId };
    },
  };

  await enqueueVideoProviderOperation(operationId, { queue });

  assert.deepEqual(jobs, [
    {
      name: "process-operation",
      data: { operationId },
      options: {
        jobId: operationId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  ]);
});
