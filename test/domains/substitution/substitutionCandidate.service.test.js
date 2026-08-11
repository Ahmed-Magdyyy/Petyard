import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectionModel } from '../../../src/domains/collection/collection.model.js';
import { OrderModel } from '../../../src/domains/order/order.model.js';
import { ProductModel } from '../../../src/domains/product/product.model.js';
import { SubcategoryModel } from '../../../src/domains/subcategory/subcategory.model.js';
import { listSubstitutionCandidatesService } from '../../../src/domains/substitution/substitution.service.js';

function leanQuery(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    lean() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function orderFixture(overrides = {}) {
  return {
    _id: '64b000000000000000000001',
    warehouse: '64b000000000000000000003',
    status: 'pending',
    sideEffectsCommitted: true,
    settlement: { migrationState: 'native' },
    items: [
      {
        product: '64b000000000000000000002',
        lineId: 'line-1',
        quantity: 2,
        fulfillmentQuantity: 2,
        itemPrice: 100,
        itemPricePiastres: 10000,
      },
    ],
    ...overrides,
  };
}

test('candidate service scopes list and count to the source product subcategory', async (t) => {
  const order = orderFixture();
  const subcategoryId = '64b000000000000000000004';
  let productFindCalls = 0;
  let listFilter;
  let countFilter;

  t.mock.method(OrderModel, 'findById', () => leanQuery(order));
  t.mock.method(ProductModel, 'find', (filter) => {
    productFindCalls += 1;
    if (productFindCalls === 1) {
      return leanQuery([
        { _id: order.items[0].product, subcategory: subcategoryId },
      ]);
    }
    listFilter = filter;
    return leanQuery([]);
  });
  t.mock.method(ProductModel, 'countDocuments', async (filter) => {
    countFilter = filter;
    return 0;
  });

  const result = await listSubstitutionCandidatesService({
    orderId: order._id,
    lineId: 'line-1',
    lang: 'en',
    page: 1,
    limit: 20,
  });

  assert.equal(listFilter.$and[0].subcategory, subcategoryId);
  assert.deepEqual(listFilter, countFilter);
  assert.deepEqual(result, {
    totalPages: 1,
    page: 1,
    results: 0,
    totalProducts: 0,
    warehouseId: order.warehouse,
    sourceLineId: 'line-1',
    data: [],
  });
});

test('candidate service fails closed when the source subcategory is unavailable', async (t) => {
  const order = orderFixture();

  t.mock.method(OrderModel, 'findById', () => leanQuery(order));
  t.mock.method(ProductModel, 'find', () =>
    leanQuery([{ _id: order.items[0].product, subcategory: null }]),
  );

  await assert.rejects(
    listSubstitutionCandidatesService({
      orderId: order._id,
      lineId: 'line-1',
      lang: 'en',
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'SUBSTITUTION_SOURCE_SUBCATEGORY_MISSING');
      return true;
    },
  );
});

test('candidate service ranks another variant of the source product first, then closest prices', async (t) => {
  const warehouse = '64b000000000000000000103';
  const subcategory = '64b000000000000000000104';
  const sourceProduct = '64b000000000000000000102';
  const blackVariant = '64b000000000000000000105';
  const greenVariant = '64b000000000000000000106';
  const blueVariant = '64b000000000000000000107';
  const exactPriceProduct = '64b000000000000000000108';
  const nearPriceProduct = '64b000000000000000000109';
  const farPriceProduct = '64b000000000000000000110';
  const order = orderFixture({
    warehouse,
    items: [
      {
        product: sourceProduct,
        variantId: blackVariant,
        lineId: 'line-1',
        quantity: 1,
        fulfillmentQuantity: 1,
        itemPrice: 100,
        itemPricePiastres: 10000,
      },
    ],
  });
  const stock = (quantity = 5) => [
    { warehouse, quantity, revision: 1 },
  ];
  const simple = (_id, name, price) => ({
    _id,
    type: 'SIMPLE',
    name_en: name,
    name_ar: name,
    subcategory,
    price,
    discountedPrice: null,
    images: [],
    warehouseStocks: stock(),
  });
  const products = [
    simple(farPriceProduct, 'Far', 140),
    simple(nearPriceProduct, 'Near', 105),
    simple(exactPriceProduct, 'Exact', 100),
    {
      _id: sourceProduct,
      type: 'VARIANT',
      name_en: 'Same product',
      name_ar: 'Same product',
      subcategory,
      images: [],
      variants: [
        {
          _id: blackVariant,
          price: 100,
          discountedPrice: null,
          options: [{ name: 'Color', value: 'Black' }],
          images: [],
          warehouseStocks: stock(),
        },
        {
          _id: blueVariant,
          price: 115,
          discountedPrice: null,
          options: [{ name: 'Color', value: 'Blue' }],
          images: [],
          warehouseStocks: stock(),
        },
        {
          _id: greenVariant,
          price: 100,
          discountedPrice: null,
          options: [{ name: 'Color', value: 'Green' }],
          images: [],
          warehouseStocks: stock(),
        },
      ],
    },
  ];
  let productFindCalls = 0;

  t.mock.method(OrderModel, 'findById', () => leanQuery(order));
  t.mock.method(ProductModel, 'find', () => {
    productFindCalls += 1;
    return productFindCalls === 1
      ? leanQuery([{ _id: sourceProduct, subcategory }])
      : leanQuery(products);
  });
  t.mock.method(ProductModel, 'countDocuments', async () => products.length);
  t.mock.method(SubcategoryModel, 'find', () => leanQuery([]));
  t.mock.method(CollectionModel, 'find', () => leanQuery([]));

  const result = await listSubstitutionCandidatesService({
    orderId: order._id,
    lineId: 'line-1',
    lang: 'en',
    page: 1,
    limit: 2,
  });

  assert.equal(result.totalPages, 2);
  assert.equal(result.results, 2);
  assert.deepEqual(
    result.data.map((candidate) => candidate.product),
    [sourceProduct, exactPriceProduct],
  );
  assert.deepEqual(
    result.data[0].variants.map((variant) => variant.variantId),
    [greenVariant, blueVariant],
  );
  assert.equal(
    result.data[0].variants.some(
      (variant) => variant.variantId === blackVariant,
    ),
    false,
  );
});
