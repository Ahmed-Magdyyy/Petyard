import { capabilities, fail, validateRequest } from "./providerContract.js";

// Scripted contract fake, not a language model or a quality benchmark.
export function createFakeAdapter(results) {
  let index = 0;
  return {
    provider: "scripted-fake", model: "fake", capabilities,
    async generate(request) {
      validateRequest(request);
      if (request.signal?.aborted) fail("cancelled");
      if (index >= results.length) fail("fake_exhausted");
      return structuredClone(results[index++]);
    },
  };
}
