import {
  area,
  booleanPointInPolygon,
  difference,
  intersect,
  multiPolygon,
  point,
  polygon,
} from '@turf/turf';
import { ApiError } from '../../shared/utils/ApiError.js';
import { isWarehouseOperational } from './warehouse.fulfillment.js';

const finitePosition = (position) =>
  Array.isArray(position) &&
  position.length === 2 &&
  position.every(Number.isFinite) &&
  position[0] >= -180 &&
  position[0] <= 180 &&
  position[1] >= -90 &&
  position[1] <= 90;
const closed = (ring) =>
  ring.length >= 4 &&
  ring[0][0] === ring.at(-1)[0] &&
  ring[0][1] === ring.at(-1)[1];
const distinctCount = (ring) =>
  new Set(ring.slice(0, -1).map((position) => `${position[0]},${position[1]}`)).size;
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a, b, position) =>
  cross(a, b, position) === 0 &&
  position[0] >= Math.min(a[0], b[0]) &&
  position[0] <= Math.max(a[0], b[0]) &&
  position[1] >= Math.min(a[1], b[1]) &&
  position[1] <= Math.max(a[1], b[1]);

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b)) ||
    ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0))
  );
}

function ringsIntersect(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

function validRing(ring) {
  if (!runtimeRing(ring)) return false;

  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    for (let j = i + 1; j < ring.length - 1; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 2)) continue;
      if (segmentsIntersect(a, b, ring[j], ring[j + 1])) return false;
    }
  }
  return true;
}

function validPolygon(coords) {
  if (!Array.isArray(coords) || !coords.length || !coords.every(validRing)) return false;
  const outer = polygon([coords[0]]);
  for (let i = 1; i < coords.length; i++) {
    const hole = polygon([coords[i]]);
    if (
      !coords[i].slice(0, -1).every((position) =>
        booleanPointInPolygon(point(position), outer, { ignoreBoundary: true }),
      )
    ) return false;
    if (ringsIntersect(coords[0], coords[i])) return false;
    for (let j = 1; j < i; j++) {
      const prior = polygon([coords[j]]);
      if (
        ringsIntersect(coords[j], coords[i]) ||
        booleanPointInPolygon(point(coords[i][0]), prior) ||
        booleanPointInPolygon(point(coords[j][0]), hole)
      ) return false;
    }
  }
  return area(polygon(coords)) > 0;
}

function validMultiPolygon(geometry) {
  if (
    geometry?.type !== 'MultiPolygon' ||
    !Array.isArray(geometry.coordinates) ||
    !geometry.coordinates.length ||
    !geometry.coordinates.every(validPolygon)
  ) return false;

  for (let i = 0; i < geometry.coordinates.length; i++) {
    for (let j = 0; j < i; j++) {
      const overlap = intersect(
        polygon(geometry.coordinates[i]),
        polygon(geometry.coordinates[j]),
      );
      if (overlap && area(overlap) > 0) return false;
    }
  }
  return true;
}

export function validatePrimeConfiguration({
  boundaryGeometry,
  primeBoundaryGeometry,
  primeShippingPrice,
  defaultShippingPrice = 0,
}) {
  const hasGeometry = primeBoundaryGeometry != null;
  const hasPrice = primeShippingPrice != null;
  if (!hasGeometry && !hasPrice) return false;

  try {
    if (!hasGeometry || !hasPrice || !validMultiPolygon(primeBoundaryGeometry)) {
      throw new ApiError(
        'Prime Location requires valid geometry and a shipping price',
        400,
      );
    }
    if (
      !Number.isFinite(primeShippingPrice) ||
      !Number.isFinite(defaultShippingPrice) ||
      primeShippingPrice < 0 ||
      defaultShippingPrice < 0 ||
      primeShippingPrice > defaultShippingPrice
    ) {
      throw new ApiError(
        'Prime shipping price must be between zero and the default shipping price',
        400,
      );
    }
    if (
      boundaryGeometry?.type !== 'Polygon' ||
      !Array.isArray(boundaryGeometry.coordinates) ||
      !validPolygon(boundaryGeometry.coordinates)
    ) {
      throw new ApiError('Prime Location requires a valid parent boundary', 400);
    }
    if (
      difference(
        multiPolygon(primeBoundaryGeometry.coordinates),
        polygon(boundaryGeometry.coordinates),
      ) !== null
    ) {
      throw new ApiError(
        'Prime Location must be fully contained in the warehouse boundary',
        400,
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Prime Location geometry or price configuration is invalid', 400);
  }
  return true;
}

function runtimeRing(ring) {
  if (!(
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every(finitePosition) &&
    closed(ring)
  )) return false;

  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const current = ring[i];
    const next = ring[i + 1];
    if (current[0] === next[0] && current[1] === next[1]) return false;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea !== 0 && distinctCount(ring) >= 3;
}

function runtimePolygon(coords) {
  return Array.isArray(coords) && coords.length > 0 && coords.every(runtimeRing);
}

function runtimeGeometry(geometry, type) {
  if (geometry?.type !== type || !Array.isArray(geometry.coordinates)) return false;
  if (type === 'Polygon') return runtimePolygon(geometry.coordinates);
  return geometry.coordinates.length > 0 && geometry.coordinates.every(runtimePolygon);
}

function safeContains(geometry, location) {
  const { lat, lng } = location || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;

  try {
    return booleanPointInPolygon(point([lng, lat]), geometry);
  } catch {
    return false;
  }
}

export function isPrimeLocation({
  zoneWarehouse,
  effectiveWarehouse,
  location,
  canDeliver = true,
}) {
  const prime = zoneWarehouse?.primeBoundaryGeometry;
  const price = zoneWarehouse?.primeShippingPrice;
  const hasMatchingIds =
    zoneWarehouse?._id != null &&
    effectiveWarehouse?._id != null &&
    String(zoneWarehouse._id) === String(effectiveWarehouse._id);

  return Boolean(
    canDeliver &&
    hasMatchingIds &&
    isWarehouseOperational(zoneWarehouse) &&
    isWarehouseOperational(effectiveWarehouse) &&
    Number.isFinite(price) &&
    price >= 0 &&
    Number.isFinite(zoneWarehouse.defaultShippingPrice) &&
    price <= zoneWarehouse.defaultShippingPrice &&
    runtimeGeometry(zoneWarehouse.boundaryGeometry, 'Polygon') &&
    runtimeGeometry(prime, 'MultiPolygon') &&
    safeContains(zoneWarehouse.boundaryGeometry, location) &&
    safeContains(prime, location)
  );
}

export function selectShippingPrice(warehouse, isPrime) {
  return isPrime ? warehouse.primeShippingPrice : warehouse.defaultShippingPrice;
}
