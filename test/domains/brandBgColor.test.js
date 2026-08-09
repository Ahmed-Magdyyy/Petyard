import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

import { BrandModel } from '../../src/domains/brand/brand.model.js';
import { getBrandsService } from '../../src/domains/brand/brand.service.js';

test('brand bgColor accepts hex colors and stores them uppercase', () => {
  const brand = new BrandModel({
    slug: 'royal-canin',
    name_en: 'Royal Canin',
    bgColor: '#a1b2c3',
  });

  assert.equal(brand.bgColor, '#A1B2C3');
  assert.equal(brand.validateSync(), undefined);
});

test('brand bgColor rejects invalid values', () => {
  const brand = new BrandModel({
    slug: 'royal-canin',
    name_en: 'Royal Canin',
    bgColor: 'blue',
  });

  const error = brand.validateSync();
  assert.ok(error?.errors.bgColor);
});

test('brand list returns bgColor and null for older brands', async (t) => {
  const queryResult = {
    sort: async () => [
      {
        _id: new mongoose.Types.ObjectId(),
        slug: 'with-color',
        name_en: 'With color',
        name_ar: null,
        desc_en: '',
        desc_ar: '',
        bgColor: '#112233',
        image: null,
        updatedAt: new Date(),
      },
      {
        _id: new mongoose.Types.ObjectId(),
        slug: 'without-color',
        name_en: 'Without color',
        name_ar: null,
        desc_en: '',
        desc_ar: '',
        image: null,
        updatedAt: new Date(),
      },
    ],
  };
  t.mock.method(BrandModel, 'find', () => queryResult);

  const result = await getBrandsService();

  assert.equal(result[0].bgColor, '#112233');
  assert.equal(result[1].bgColor, null);
});
