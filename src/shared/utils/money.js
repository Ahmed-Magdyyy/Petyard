const EGP_SCALE = 100;

function invalidMoney(field, message) {
  return new TypeError(`${field} ${message}`);
}

export function isSafePiastres(value, { allowNegative = false } = {}) {
  return Number.isSafeInteger(value) && (allowNegative || value >= 0);
}

export function assertPiastres(value, field = 'amountPiastres', options = {}) {
  if (!isSafePiastres(value, options)) {
    const qualifier = options.allowNegative
      ? 'a safe integer'
      : 'a non-negative safe integer';
    throw invalidMoney(field, `must be ${qualifier}`);
  }
  return value;
}

// Convert a decimal EGP input exactly once at an API boundary. Internal
// settlement calculations must use only the returned integer piastres.
export function toPiastres(value, field = 'amount') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidMoney(field, 'must be a finite non-negative number');
  }

  return assertPiastres(Math.round(value * EGP_SCALE), `${field}Piastres`);
}

export function fromPiastres(value, field = 'amountPiastres') {
  return assertPiastres(value, field) / EGP_SCALE;
}

export function normalizeCurrency(currency = 'EGP') {
  if (typeof currency !== 'string') {
    throw invalidMoney('currency', 'must be a three-letter currency code');
  }

  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw invalidMoney('currency', 'must be a three-letter currency code');
  }
  return normalized;
}

export const EGP_PIASTRES_PER_POUND = EGP_SCALE;
