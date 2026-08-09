import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EGP_PIASTRES_PER_POUND,
  assertPiastres,
  fromPiastres,
  normalizeCurrency,
  toPiastres,
} from '../../src/shared/utils/money.js';

test('money converts EGP to integer piastres once', () => {
  assert.equal(EGP_PIASTRES_PER_POUND, 100);
  assert.equal(toPiastres(19.995), 2000);
  assert.equal(toPiastres(0), 0);
  assert.equal(fromPiastres(2000), 20);
});

test('money rejects unsafe, negative, and non-finite values', () => {
  assert.throws(() => toPiastres(-0.01), /finite non-negative/);
  assert.throws(() => toPiastres(Number.NaN), /finite non-negative/);
  assert.throws(() => assertPiastres(1.2), /non-negative safe integer/);
  assert.throws(() => assertPiastres(Number.MAX_SAFE_INTEGER + 1), /non-negative safe integer/);
});

test('currency is normalized and validated', () => {
  assert.equal(normalizeCurrency(' egp '), 'EGP');
  assert.throws(() => normalizeCurrency('EGYPT'), /three-letter/);
});
