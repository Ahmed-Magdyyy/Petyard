import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countSubstitutionCandidateProducts,
  findSubstitutionCandidateProducts,
} from '../../../src/domains/product/product.repository.js';

test('candidate product queries exclude a simple source product consistently', () => {
  const options = {
    warehouseId: 'warehouse-1',
    subcategoryId: 'subcategory-1',
    excludeProductId: 'product-1',
  };
  const listFilter = findSubstitutionCandidateProducts(options).getFilter();
  const countFilter = countSubstitutionCandidateProducts(options).getFilter();

  assert.deepEqual(listFilter, countFilter);
  assert.equal(listFilter.$and[0].subcategory, 'subcategory-1');
  assert.deepEqual(listFilter.$and[1], {
    _id: { $ne: 'product-1' },
  });
});

test('candidate product queries retain other in-stock variants of the source product', () => {
  const options = {
    warehouseId: 'warehouse-1',
    subcategoryId: 'subcategory-1',
    excludeProductId: 'product-1',
    excludeVariantId: 'variant-1',
  };
  const filter = findSubstitutionCandidateProducts(options).getFilter();

  assert.equal(filter.$and[0].subcategory, 'subcategory-1');
  assert.deepEqual(filter.$and[1], {
    $or: [
      { _id: { $ne: 'product-1' } },
      {
        _id: 'product-1',
        type: 'VARIANT',
        variants: {
          $elemMatch: {
            _id: { $ne: 'variant-1' },
            warehouseStocks: {
              $elemMatch: {
                warehouse: 'warehouse-1',
                quantity: { $gt: 0 },
              },
            },
          },
        },
      },
    ],
  });
});

test('candidate product search remains scoped to the source subcategory', () => {
  const searchRegex = /adult cat food/i;
  const options = {
    warehouseId: 'warehouse-1',
    subcategoryId: 'subcategory-1',
    searchRegex,
    excludeProductId: 'product-1',
  };
  const filter = findSubstitutionCandidateProducts(options).getFilter();

  assert.equal(filter.$and[0].subcategory, 'subcategory-1');
  assert.deepEqual(filter.$and[0].$and[1].$or, [
    { name_en: searchRegex },
    { name_ar: searchRegex },
    { slug: searchRegex },
    { sku: searchRegex },
    { 'variants.sku': searchRegex },
  ]);
});
