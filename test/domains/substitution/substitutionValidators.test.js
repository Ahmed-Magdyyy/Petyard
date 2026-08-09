import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSubstitutionJsonFields,
  respondToSubstitutionValidator,
} from "../../../src/domains/substitution/substitution.validators.js";

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

test("multipart substitution responses normalize validated integer fields", async () => {
  const req = {
    body: {
      requestRevision: "3",
      selections: JSON.stringify([
        {
          shortageId: "shortage-1",
          choices: [{ candidateId: "candidate-1", quantity: 2 }],
        },
      ]),
      quoteRevision: "quote-revision",
      quotedWalletBalancePiastres: "1250",
    },
    params: {
      id: "507f1f77bcf86cd799439011",
      requestId: "507f1f77bcf86cd799439012",
    },
    headers: { "idempotency-key": "response-key-123" },
    query: {},
    cookies: {},
  };

  await runMiddleware(parseSubstitutionJsonFields, req);
  for (const middleware of respondToSubstitutionValidator) {
    await runMiddleware(middleware, req);
  }

  assert.equal(req.body.requestRevision, 3);
  assert.equal(req.body.quotedWalletBalancePiastres, 1250);
  assert.equal(req.body.selections[0].choices[0].quantity, 2);
});
