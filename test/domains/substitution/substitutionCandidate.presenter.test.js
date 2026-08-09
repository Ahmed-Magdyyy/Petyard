import assert from 'node:assert/strict';
import test from 'node:test';
import { presentSubstitutionCandidateProduct } from '../../../src/domains/substitution/substitutionCandidate.presenter.js';

function snapshot(overrides = {}) {
  return {
    product: 'product-1',
    productType: 'VARIANT',
    productName_en: 'Adult cat food',
    productName_ar: 'طعام قطط بالغة',
    productImageUrl: 'https://cdn.example/cat-food.webp',
    variantId: 'variant-1',
    variantOptions: [{ name: 'Weight', value: '1 kg' }],
    basePrice: 200,
    discountedPrice: 175,
    unitPricePiastres: 17500,
    stockQuantity: 7,
    stockRevision: 3,
    ...overrides,
  };
}

test('candidate product presenter localizes and groups variants with EGP prices', () => {
  const result = presentSubstitutionCandidateProduct(
    [
      snapshot(),
      snapshot({
        variantId: 'variant-2',
        variantOptions: [{ name: 'Weight', value: '4 kg' }],
        basePrice: 690,
        discountedPrice: null,
        unitPricePiastres: 69000,
        stockQuantity: 11,
        stockRevision: 5,
      }),
    ],
    'ar',
  );

  assert.equal(result.name, 'طعام قطط بالغة');
  assert.equal(result.price, 200);
  assert.equal(result.discountedPrice, 175);
  assert.equal(result.hasVariants, true);
  assert.equal(result.variants.length, 2);
  assert.deepEqual(result.variants[0], {
    variantId: 'variant-1',
    options: [{ name: 'Weight', value: '1 kg' }],
    productImageUrl: 'https://cdn.example/cat-food.webp',
    price: 200,
    discountedPrice: 175,
    stockQuantity: 7,
    stockRevision: 3,
  });
  assert.equal('unitPricePiastres' in result, false);
  assert.equal('productName_en' in result, false);
  assert.equal('productName_ar' in result, false);
});

test('simple candidate exposes direct stock and defaults to English', () => {
  const result = presentSubstitutionCandidateProduct(
    [
      snapshot({
        productType: 'SIMPLE',
        variantId: undefined,
        variantOptions: [],
        discountedPrice: null,
        unitPricePiastres: 20000,
      }),
    ],
    'en',
  );

  assert.equal(result.name, 'Adult cat food');
  assert.equal(result.price, 200);
  assert.equal(result.discountedPrice, null);
  assert.equal(result.hasVariants, false);
  assert.equal(result.stockQuantity, 7);
  assert.equal(result.stockRevision, 3);
  assert.deepEqual(result.variants, []);
});
