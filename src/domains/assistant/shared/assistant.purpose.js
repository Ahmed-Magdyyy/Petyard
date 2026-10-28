export const runPurposes = Object.freeze({ customer: "customer", adminBusiness: "admin_business", automaticBundles: "automatic_bundles" });

export const isCustomerRun = (run) => !!run && (run.purpose === undefined || run.purpose === runPurposes.customer);

// Missing purpose belongs to legacy customer runs; null and unknown purposes fail closed.
export function customerRunFilter(filter) {
  return { $and: [filter, { $or: [{ purpose: runPurposes.customer }, { purpose: { $exists: false } }] }] };
}
