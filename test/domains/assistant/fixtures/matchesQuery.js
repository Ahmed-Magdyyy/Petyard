// Only the operators exercised by these local query tests; not a MongoDB substitute.
export function matchesQuery(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") return expected.every((part) => matchesQuery(row, part));
    if (key === "$or") return expected.some((part) => matchesQuery(row, part));
    const value = row[key];
    if (expected && expected.constructor === Object) return Object.entries(expected).every(([operator, operand]) => {
      if (operator === "$exists") return Object.hasOwn(row, key) === operand;
      if (operator === "$ne") return value !== operand;
      if (operator === "$in") return operand.includes(value);
      if (operator === "$lte") return value <= operand;
      if (operator === "$lt") return value < operand;
      if (operator === "$gt") return value > operand;
      throw new Error(`Unsupported test operator: ${operator}`);
    });
    return expected === null && value === undefined || (value?.toHexString || expected?.toHexString ? String(value) === String(expected) : value === expected);
  });
}
