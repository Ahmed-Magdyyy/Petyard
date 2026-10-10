import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../../src/shared/utils/ApiError.js';
import {
  isPrimeLocation,
  selectShippingPrice,
  validatePrimeConfiguration,
} from '../../src/domains/warehouse/warehouse.delivery.js';

const ring = (minLng, minLat, maxLng, maxLat) => [
  [minLng, minLat],
  [maxLng, minLat],
  [maxLng, maxLat],
  [minLng, maxLat],
  [minLng, minLat],
];
const polygonCoordinates = (...rings) => rings;
const multiPolygon = (...polygons) => ({
  type: 'MultiPolygon',
  coordinates: polygons,
});
const parentBoundary = {
  type: 'Polygon',
  coordinates: polygonCoordinates(ring(0, 0, 10, 10)),
};
const openRing = [[1, 1], [2, 1], [2, 2], [1, 2]];
const config = ({
  primeBoundaryGeometry = multiPolygon(polygonCoordinates(ring(1, 1, 2, 2))),
  primeShippingPrice = 5,
  boundaryGeometry = parentBoundary,
  defaultShippingPrice = 10,
} = {}) => ({
  primeBoundaryGeometry,
  primeShippingPrice,
  boundaryGeometry,
  defaultShippingPrice,
});
const location = (lng, lat) => ({ lat, lng });
const warehouse = (overrides = {}) => ({
  _id: 'source-id',
  active: true,
  fulfillment: { status: 'OPERATIONAL' },
  defaultShippingPrice: 10,
  primeShippingPrice: 5,
  boundaryGeometry: parentBoundary,
  primeBoundaryGeometry: multiPolygon(polygonCoordinates(ring(1, 1, 2, 2))),
  ...overrides,
});

test('Prime config can be disabled and validates price boundaries', () => {
  assert.equal(validatePrimeConfiguration({}), false);
  assert.equal(
    validatePrimeConfiguration({
      primeBoundaryGeometry: null,
      primeShippingPrice: null,
    }),
    false,
  );
  assert.throws(
    () => validatePrimeConfiguration(config({ primeShippingPrice: null })),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
  assert.equal(
    validatePrimeConfiguration(config({ primeShippingPrice: 0 })),
    true,
  );
  assert.equal(validatePrimeConfiguration({
    boundaryGeometry: parentBoundary,
    primeBoundaryGeometry: multiPolygon(polygonCoordinates(ring(1, 1, 2, 2))),
    primeShippingPrice: 0,
  }), true);
  assert.throws(
    () => validatePrimeConfiguration({
      boundaryGeometry: parentBoundary,
      primeBoundaryGeometry: multiPolygon(polygonCoordinates(ring(1, 1, 2, 2))),
      primeShippingPrice: 1,
    }),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
  assert.equal(
    validatePrimeConfiguration(config({ primeShippingPrice: 10 })),
    true,
  );
  assert.throws(
    () => validatePrimeConfiguration(config({ primeShippingPrice: 11 })),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
});

test('full polygon containment rejects concavity crossings, parent holes, and overlap', () => {
  const concaveBoundary = {
    type: 'Polygon',
    coordinates: polygonCoordinates([
      [0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0],
    ]),
  };
  assert.throws(
    () => validatePrimeConfiguration(config({
      primeBoundaryGeometry: multiPolygon(polygonCoordinates(ring(1, 1, 4, 4))),
      boundaryGeometry: concaveBoundary,
    })),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );

  const boundaryWithHole = {
    type: 'Polygon',
    coordinates: polygonCoordinates(ring(0, 0, 10, 10), ring(4, 4, 8, 8)),
  };
  assert.equal(validatePrimeConfiguration(config({
    boundaryGeometry: boundaryWithHole,
  })), true);
  assert.throws(
    () => validatePrimeConfiguration(config({
      primeBoundaryGeometry: multiPolygon(polygonCoordinates(ring(5, 5, 6, 6))),
      boundaryGeometry: boundaryWithHole,
    })),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
  assert.throws(
    () => validatePrimeConfiguration(config({
      primeBoundaryGeometry: multiPolygon(
        polygonCoordinates(ring(1, 1, 3, 3)),
        polygonCoordinates(ring(2, 2, 4, 4)),
      ),
    })),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
});

test('malformed rings and invalid hole topology produce configuration errors', () => {
  const selfCrossing = [[1, 1], [2, 2], [1, 2], [2, 1], [1, 1]];
  const outsideHole = polygonCoordinates(ring(1, 1, 2, 2), ring(3, 3, 4, 4));
  const crossingHole = polygonCoordinates(
    ring(0, 0, 5, 5),
    [[4, 2], [6, 2], [6, 3], [4, 3], [4, 2]],
  );

  for (const geometry of [
    multiPolygon(polygonCoordinates(selfCrossing)),
    multiPolygon(polygonCoordinates(openRing)),
    multiPolygon(outsideHole),
    multiPolygon(crossingHole),
    { type: 'MultiPolygon', coordinates: [[]] },
    { type: 'MultiPolygon', coordinates: [[[[1, 1], [2, 1], [NaN, 2], [1, 1]]]] },
  ]) {
    assert.throws(
      () => validatePrimeConfiguration(config({ primeBoundaryGeometry: geometry })),
      (error) => error instanceof ApiError && error.statusCode === 400,
    );
  }
});

test('eligibility accepts components and all edges while excluding gaps and hole interiors', () => {
  const twoComponents = warehouse({
    primeBoundaryGeometry: multiPolygon(
      polygonCoordinates(ring(1, 1, 2, 2)),
      polygonCoordinates(ring(4, 1, 5, 2)),
    ),
  });
  for (const position of [location(1.5, 1.5), location(4.5, 1.5)]) {
    assert.equal(isPrimeLocation({
      zoneWarehouse: twoComponents,
      effectiveWarehouse: { ...twoComponents },
      location: position,
    }), true);
  }
  assert.equal(isPrimeLocation({
    zoneWarehouse: twoComponents,
    effectiveWarehouse: twoComponents,
    location: location(3, 1.5),
  }), false);

  const withHole = warehouse({
    primeBoundaryGeometry: multiPolygon(
      polygonCoordinates(ring(1, 1, 4, 4), ring(2, 2, 3, 3)),
    ),
  });
  assert.equal(isPrimeLocation({
    zoneWarehouse: withHole,
    effectiveWarehouse: withHole,
    location: location(2.5, 2.5),
  }), false);
  assert.equal(isPrimeLocation({
    zoneWarehouse: withHole,
    effectiveWarehouse: withHole,
    location: location(2, 2.5),
  }), true);

  const islandInHole = warehouse({
    primeBoundaryGeometry: multiPolygon(
      polygonCoordinates(ring(1, 1, 5, 5), ring(2, 2, 4, 4)),
      polygonCoordinates(ring(2.5, 2.5, 3.5, 3.5)),
    ),
  });
  assert.equal(isPrimeLocation({
    zoneWarehouse: islandInHole,
    effectiveWarehouse: islandInHole,
    location: location(3, 3),
  }), true);
  assert.equal(isPrimeLocation({
    zoneWarehouse: twoComponents,
    effectiveWarehouse: twoComponents,
    location: location(1, 1),
  }), true);
});

test('eligibility requires real matching operational ids and valid delivery data', () => {
  const source = warehouse();
  assert.equal(isPrimeLocation({
    zoneWarehouse: source,
    effectiveWarehouse: { ...source, _id: 'other-id' },
    location: location(1.5, 1.5),
  }), false);
  assert.equal(isPrimeLocation({
    zoneWarehouse: { ...source, _id: undefined },
    effectiveWarehouse: { ...source, _id: undefined },
    location: location(1.5, 1.5),
  }), false);
  assert.equal(isPrimeLocation({
    zoneWarehouse: source,
    effectiveWarehouse: { ...source, fulfillment: { status: 'MAINTENANCE' } },
    location: location(1.5, 1.5),
  }), false);
  assert.equal(isPrimeLocation({
    zoneWarehouse: { ...source, active: false },
    effectiveWarehouse: source,
    location: location(1.5, 1.5),
  }), false);
  assert.equal(isPrimeLocation({
    zoneWarehouse: source,
    effectiveWarehouse: source,
    location: location(1.5, 1.5),
    canDeliver: false,
  }), false);

  const reroutedZone = warehouse({ fulfillment: { status: 'MAINTENANCE' } });
  const primeFallback = warehouse({ _id: 'fallback-id' });
  assert.equal(isPrimeLocation({
    zoneWarehouse: reroutedZone,
    effectiveWarehouse: primeFallback,
    location: location(1.5, 1.5),
  }), false);

  const zeroPrice = warehouse({ primeShippingPrice: 0 });
  const equalPrice = warehouse({ primeShippingPrice: 10 });
  assert.equal(isPrimeLocation({
    zoneWarehouse: zeroPrice,
    effectiveWarehouse: zeroPrice,
    location: location(1.5, 1.5),
  }), true);
  assert.equal(isPrimeLocation({
    zoneWarehouse: equalPrice,
    effectiveWarehouse: equalPrice,
    location: location(1.5, 1.5),
  }), true);
  assert.equal(selectShippingPrice(zeroPrice, true), 0);
  assert.equal(selectShippingPrice(equalPrice, true), 10);
  assert.equal(selectShippingPrice(source, false), 10);
});

test('malformed runtime geometries and coordinates fail closed without throwing', () => {
  const source = warehouse();
  const malformedGeometries = [
    { type: 'MultiPolygon', coordinates: 'bad' },
    { type: 'MultiPolygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [polygonCoordinates(openRing)] },
    { type: 'MultiPolygon', coordinates: [[polygonCoordinates([
      [1, 1], [2, 1], [2, 2], [NaN, 2], [1, 1],
    ])[0]]] },
    { type: 'MultiPolygon', coordinates: [[[]]] },
  ];
  for (const geometry of malformedGeometries) {
    assert.equal(isPrimeLocation({
      zoneWarehouse: { ...source, primeBoundaryGeometry: geometry },
      effectiveWarehouse: source,
      location: location(1.5, 1.5),
    }), false);
  }
  assert.equal(isPrimeLocation({
    zoneWarehouse: {
      ...source,
      boundaryGeometry: { type: 'Polygon', coordinates: polygonCoordinates(openRing) },
    },
    effectiveWarehouse: source,
    location: location(1.5, 1.5),
  }), false);
  for (const position of [
    { lat: NaN, lng: 1.5 },
    { lat: 1.5, lng: Infinity },
    { lat: 91, lng: 1.5 },
    { lat: 1.5, lng: -181 },
    { coordinates: [1.5, 1.5] },
  ]) {
    assert.equal(isPrimeLocation({
      zoneWarehouse: source,
      effectiveWarehouse: source,
      location: position,
    }), false);
  }
});
