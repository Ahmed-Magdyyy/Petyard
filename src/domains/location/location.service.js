import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { getOrSetCache } from "../../shared/cache.js";
import axios from "axios";
import { booleanPointInPolygon } from "@turf/turf";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const governoratesConfig = require("../../shared/constants/governorates.json");

const GOVERNORATES_BY_CODE = new Map(
  (governoratesConfig.governorates || []).map((g) => [g.code, g])
);

function isSupportedGovernorate(code) {
  if (!code) return false;
  const entry = GOVERNORATES_BY_CODE.get(code);
  return !!entry && !!entry.supported;
}

function summarizeWarehouse(warehouse) {
  if (!warehouse) return null;
  return {
    id: warehouse._id,
    name: warehouse.name,
    code: warehouse.code || null,
    governorate: warehouse.governorate || null,
    isDefault: Boolean(warehouse.isDefault),
    defaultShippingPrice: warehouse.defaultShippingPrice ?? 0,
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function pickNearestWarehouseByLocation(candidates, { latNum, lngNum }) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  let best = null;
  let bestDist = Infinity;

  candidates.forEach((wh) => {
    const coords = wh.location?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [whLng, whLat] = coords;
    if (typeof whLat !== "number" || typeof whLng !== "number") return;

    const dist = haversineKm(latNum, lngNum, whLat, whLng);
    if (dist < bestDist) {
      bestDist = dist;
      best = wh;
    }
  });

  return best || candidates[0];
}

async function reverseGeocodeGovernorate({ latNum, lngNum }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return { raw: null, normalized: null };
  }

  try {
    const url = "https://maps.googleapis.com/maps/api/geocode/json";
    const params = {
      latlng: `${latNum},${lngNum}`,
      key: apiKey,
      language: "en",
      result_type: "administrative_area_level_1|administrative_area_level_2",
    };

    const { data } = await axios.get(url, { params });

    if (!data || !Array.isArray(data.results) || !data.results.length) {
      return { raw: null, normalized: null };
    }

    console.log("reverse geo result:", data.results);
    
    let govName = null;

    for (const result of data.results) {
      const components = result.address_components || [];

      let level1Name = null;
      let level2Name = null;

      for (const comp of components) {
        const types = comp.types || [];

        if (types.includes("administrative_area_level_1")) {
          level1Name = comp.long_name || comp.short_name || null;
        } else if (types.includes("administrative_area_level_2") && !level2Name) {
          level2Name = comp.long_name || comp.short_name || null;
        }
      }

      if (level1Name || level2Name) {
        govName = level1Name || level2Name;
        break;
      }
    }
    
    if (!govName) {
      return { raw: null, normalized: null };
    }

    const normalized = normalizeGovernorateName(govName);

    return {
      raw: govName,
      normalized,
    };
  } catch (err) {
    console.error(
      "[reverseGeocodeGovernorate] Failed to reverse geocode governorate:",
      err.message
    );
    return { raw: null, normalized: null };
  }
}

function normalizeGovernorateName(raw) {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.toLowerCase().trim();

  // 1) Direct match against configured governorate codes
  for (const [code] of GOVERNORATES_BY_CODE.entries()) {
    if (value === code) {
      return code;
    }
  }

  // 2) Match using English/Arabic names or simple code variants from governorates.json
  for (const [code, gov] of GOVERNORATES_BY_CODE.entries()) {
    const labelEn = (gov.name_en || gov.label || gov.name || "").toLowerCase();
    const labelAr = (gov.name_ar || "").toLowerCase();
    const codeSpaced = code.replace(/_/g, " ");
    const candidates = [code, codeSpaced, labelEn, labelAr];

    if (candidates.some((term) => term && value.includes(term))) {
      return code;
    }
  }

  // 3) Fallback manual synonyms for tricky transliterations
  const mappings = [
    { code: "alexandria", keys: ["aleksandria", "alex"] },
    { code: "giza", keys: ["gizah"] },
    { code: "dakahlia", keys: ["daqahlia", "ad daqahliyah"] },
    { code: "red_sea", keys: ["al bahr al ahmar"] },
    { code: "beheira", keys: ["behira", "al buhayrah"] },
    { code: "fayoum", keys: ["faiyum", "fayum", "al fayyum"] },
    { code: "gharbia", keys: ["gharbiya", "al gharbiyah"] },
    { code: "ismailia", keys: ["ismailiya", "al ismaliyah"] },
    { code: "monufia", keys: ["menoufia", "minufiya"] },
    { code: "minya", keys: ["minia", "al minya"] },
    { code: "qalyubia", keys: ["qaliubiya", "al qalyubiyah"] },
    {
      code: "new_valley",
      keys: ["al wadi al jadid", "el wadi el gedid"],
    },
    { code: "north_sinai", keys: ["shamal sina"] },
    { code: "port_said", keys: ["bur sa'id"] },
    { code: "sharqia", keys: ["sharqiya", "ash sharqiyah"] },
    { code: "sohag", keys: ["suhag"] },
    { code: "south_sinai", keys: ["janub sina"] },
    { code: "damietta", keys: ["dumiyat"] },
    {
      code: "kafr_el_sheikh",
      keys: ["kafr ash sheikh", "kafr el-shaykh"],
    },
    {
      code: "matrouh",
      keys: ["matruh", "marsa matrouh", "marsamatruh"],
    },
    { code: "luxor", keys: ["al uqsur"] },
    { code: "qena", keys: ["qina"] },
    { code: "asyut", keys: ["assiut", "asuyt"] },
    { code: "beni_suef", keys: ["bani suwayf"] },
    { code: "aswan", keys: ["aswan governorate"] },
    { code: "suez", keys: ["as suways"] },
  ];

  for (const { code, keys } of mappings) {
    if (keys.some((k) => value.includes(k))) {
      return code;
    }
  }

  return null;
}

async function findNearestWarehouseByGovernorate({ governorate, latNum, lngNum }) {
  if (!governorate) return null;

  const userPoint = {
    type: "Point",
    coordinates: [lngNum, latNum],
  };

  const warehouse = await WarehouseModel.findOne({
    governorate,
    active: true,
    location: {
      $near: {
        $geometry: userPoint,
      },
    },
  });

  return warehouse;
}

async function findDefaultWarehouse() {
  let warehouse = await WarehouseModel.findOne({ isDefault: true, active: true });

  if (!warehouse) {
    warehouse = await WarehouseModel.findOne({ active: true }).sort({ createdAt: 1 });
  }

  return warehouse;
}
 
export async function resolveLocationByCoordinatesService({
  lat,
  lng,
  governorateCode,
  areaCode,
}) {
  const hasCoords = typeof lat !== "undefined" && typeof lng !== "undefined";
  const source = hasCoords ? "gps" : "manual";

  // Governorate/area-only mode (manual selection, no precise coordinates)
  if (!hasCoords) {
    if (!governorateCode || typeof governorateCode !== "string") {
      throw new ApiError("Either (lat & lng) or governorateCode must be provided", 400);
    }

    const govCode = governorateCode.toLowerCase().trim();
    const govConfig = GOVERNORATES_BY_CODE.get(govCode);

    if (!govConfig) {
      throw new ApiError("Unknown governorate code", 400);
    }

    const isSupported = isSupportedGovernorate(govCode);

    let productsWarehouse = null;
    let selectedArea = null;

    if (isSupported) {
      const simpleAreas = Array.isArray(govConfig.areas) ? govConfig.areas : [];
      const warehouseGroups = Array.isArray(govConfig.warehouses)
        ? govConfig.warehouses
        : [];

      const groupedAreas = [];
      warehouseGroups.forEach((group) => {
        const groupWarehouseCode = group.code || group.warehouseCode || null;
        const groupAreas = Array.isArray(group.areas) ? group.areas : [];

        groupAreas.forEach((a) => {
          groupedAreas.push({
            ...a,
            warehouseCode:
              a.warehouseCode || a.warehouse_code || groupWarehouseCode,
          });
        });
      });

      const flattenedAreas = simpleAreas.concat(groupedAreas);

      const areaCodeNormalized =
        typeof areaCode === "string" ? areaCode.toLowerCase().trim() : null;
console.log(areaCodeNormalized);

      if (flattenedAreas.length > 0) {
        if (!areaCodeNormalized) {
          throw new ApiError("areaCode is required for this governorate", 400);
        }

        selectedArea =
          flattenedAreas.find((a) => {
            const code =
              typeof a.code === "string" ? a.code.toLowerCase().trim() : null;
            return code && code === areaCodeNormalized;
          }) || null;

        if (!selectedArea) {
          throw new ApiError("Unknown area code for this governorate", 400);
        }

        const areaWarehouseCode =
          selectedArea.warehouseCode || selectedArea.warehouse_code || null;

        if (areaWarehouseCode) {
          productsWarehouse =
            (await WarehouseModel.findOne({
              code: areaWarehouseCode.toUpperCase(),
              active: true,
            })) || null;
        }
      }

      if (!productsWarehouse) {
        productsWarehouse =
          (await WarehouseModel.findOne({ governorate: govCode, active: true }).sort({
            createdAt: 1,
          })) || (await findDefaultWarehouse());
      }
    } else {
      productsWarehouse = await findDefaultWarehouse();
    }

    if (!productsWarehouse) {
      throw new ApiError("No active warehouse configured", 500);
    }

    const warehouseSummary = summarizeWarehouse(productsWarehouse);

    return {
      warehouse: warehouseSummary,
      productsWarehouse: warehouseSummary,
      deliveryWarehouse: null,
      location: {
        source,
        coordinates: {
          lat: null,
          lng: null,
        },
        governorate: {
          name: govCode,
          isSupported,
        },
        area: selectedArea
          ? {
              code: selectedArea.code || null,
            }
          : null,
      },
      delivery: {
        canDeliver: false,
        coverageStatus: isSupported
          ? "GOVERNORATE_ONLY_SUPPORTED"
          : "GOVERNORATE_ONLY_UNSUPPORTED",
        reasonCode: "PRECISE_LOCATION_REQUIRED",
        reasonMessage:
          "Exact location is required to confirm delivery availability.",
        requiresPreciseLocation: true,
        effectiveShippingPrice: productsWarehouse.defaultShippingPrice ?? 0,
        shippingFee: null,
        defaultShippingPrice: productsWarehouse.defaultShippingPrice ?? 0,
      },
    };
  }

  // Point/coordinates mode
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    throw new ApiError("lat and lng must be numbers", 400);
  }

  let decisionRawGov = null;
  let decisionNormalizedGov = null;
  let isDecisionGovSupported = false;

  const userPoint = {
    type: "Point",
    coordinates: [lngNum, latNum],
  };

  const warehousesWithBoundary = await WarehouseModel.find({
    active: true,
    boundaryGeometry: { $exists: true },
  }).select(
    "name code governorate active defaultShippingPrice isDefault location boundaryGeometry"
  );

  const insideCandidates = [];

  warehousesWithBoundary.forEach((warehouse) => {
    const geom = warehouse.boundaryGeometry;
    if (
      !geom ||
      geom.type !== "Polygon" ||
      !Array.isArray(geom.coordinates) ||
      !geom.coordinates.length
    ) {
      return;
    }

    const cleanedPolygon = {
      type: "Polygon",
      coordinates: geom.coordinates.map((ring) =>
        Array.isArray(ring)
          ? ring
              .map((coord) => {
                if (!Array.isArray(coord) || coord.length < 2) return null;
                const [lngCoord, latCoord] = coord;
                if (
                  typeof lngCoord !== "number" ||
                  typeof latCoord !== "number"
                ) {
                  return null;
                }
                return [lngCoord, latCoord];
              })
              .filter(Boolean)
          : []
      ),
    };

    if (
      !Array.isArray(cleanedPolygon.coordinates[0]) ||
      !cleanedPolygon.coordinates[0].length
    ) {
      return;
    }

    const inside = booleanPointInPolygon(userPoint, cleanedPolygon);
    if (inside) {
      insideCandidates.push(warehouse);
    }
  });

  // If the point is outside all boundaries and we don't yet know the governorate,
  // perform reverse geocoding on the backend to infer it.
  if (!insideCandidates.length && !decisionNormalizedGov) {
    const geo = await reverseGeocodeGovernorate({ latNum, lngNum });
    if (geo.raw) {
      decisionRawGov = geo.raw;
    }
    if (geo.normalized) {
      decisionNormalizedGov = geo.normalized;
      isDecisionGovSupported = isSupportedGovernorate(decisionNormalizedGov);
    }
  }

  let productsWarehouseDoc;
  let deliveryWarehouseDoc;
  let coverageStatus;
  let scenario;
  let reasonCode = null;
  let reasonMessage = null;
  let canDeliver;

  if (insideCandidates.length > 0) {
    const chosen = pickNearestWarehouseByLocation(insideCandidates, {
      latNum,
      lngNum,
    });
    productsWarehouseDoc = chosen;
    deliveryWarehouseDoc = chosen;
    coverageStatus = "INSIDE_BOUNDARY";
    scenario = "INSIDE_BOUNDARY";
    canDeliver = true;
  } else if (decisionNormalizedGov && isDecisionGovSupported) {
    let nearest = await findNearestWarehouseByGovernorate({
      governorate: decisionNormalizedGov,
      latNum,
      lngNum,
    });

    if (!nearest) {
      nearest = await findDefaultWarehouse();
    }

    productsWarehouseDoc = nearest;
    deliveryWarehouseDoc = null;
    coverageStatus = "OUTSIDE_BOUNDARIES_SUPPORTED_GOVERNORATE";
    scenario = "OUTSIDE_BOUNDARIES_SUPPORTED_GOVERNORATE";
    canDeliver = false;
    reasonCode = "NON_DELIVERABLE_OUTSIDE_BOUNDARIES_SUPPORTED_GOV";
    reasonMessage =
      "We currently don't deliver to this exact area, but you can still browse products.";
  } else {
    const defaultWarehouse = await findDefaultWarehouse();
    if (!defaultWarehouse) {
      throw new ApiError("No active warehouse configured", 500);
    }
    productsWarehouseDoc = defaultWarehouse;
    deliveryWarehouseDoc = defaultWarehouse;
    coverageStatus = "OUTSIDE_BOUNDARIES_UNSUPPORTED_GOVERNORATE";
    scenario = "OUTSIDE_BOUNDARIES_UNSUPPORTED_GOVERNORATE";
    canDeliver = true;
  }

  const normalizedFromWarehouse = productsWarehouseDoc.governorate || null;
  const normalizedGov = decisionNormalizedGov || normalizedFromWarehouse;
  const isSupported = isSupportedGovernorate(normalizedGov);

  const priceSource = deliveryWarehouseDoc || productsWarehouseDoc;
  const effectiveShippingPrice = priceSource.defaultShippingPrice ?? 0;

  const productsSummary = summarizeWarehouse(productsWarehouseDoc);
  const deliverySummary = summarizeWarehouse(deliveryWarehouseDoc);

  return {
    warehouse: productsSummary,
    productsWarehouse: productsSummary,
    deliveryWarehouse: deliverySummary,
    location: {
      source,
      coordinates: {
        lat: latNum,
        lng: lngNum,
      },
      governorate: {
        raw: decisionRawGov,
        normalized: normalizedGov,
        isSupported,
      },
    },
    delivery: {
      canDeliver,
      coverageStatus,
      scenario,
      reasonCode,
      reasonMessage,
      requiresPreciseLocation: false,
      effectiveShippingPrice,
      shippingFee: null,
      defaultShippingPrice:
        productsWarehouseDoc.defaultShippingPrice ?? 0,
    },
  };
}

export async function getLocationOptionsService(lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const cacheKey = `location:options:${normalizedLang}`;
  const ttlSeconds = 600; // cache for 10 minutes

  const result = await getOrSetCache(cacheKey, ttlSeconds, async () => {
    const defaultWarehouse = await findDefaultWarehouse();
    const activeWarehouses = await WarehouseModel.find({ active: true }).select(
      "_id code governorate"
    );
    const warehousesByCode = new Map(
      activeWarehouses.map((w) => [w.code, w])
    );

    const governorates = (governoratesConfig.governorates || []).map((g) => {
      const simpleAreas = Array.isArray(g.areas) && g.areas.length > 0 ? g.areas : [];
      const warehouseGroups = Array.isArray(g.warehouses) ? g.warehouses : [];

      const groupedAreas = [];
      warehouseGroups.forEach((group) => {
        const groupWarehouseCode = group.code || group.warehouseCode || null;
        const groupAreas = Array.isArray(group.areas) ? group.areas : [];

        groupAreas.forEach((a) => {
          groupedAreas.push({
            ...a,
            warehouseCode:
              a.warehouseCode || a.warehouse_code || groupWarehouseCode,
          });
        });
      });

      const flattenedAreas = simpleAreas.concat(groupedAreas);

      const name = pickLocalizedField(g, "name", normalizedLang) || g.code;

      return {
        code: g.code,
        name,
        isSupported: !!g.supported,
        hasAreas: flattenedAreas.length > 0,
        areas: flattenedAreas.map((a) => {
          const warehouseCode = a.warehouseCode || a.warehouse_code || null;
          const wh =
            warehouseCode && warehousesByCode.has(warehouseCode)
              ? warehousesByCode.get(warehouseCode)
              : null;
          const resolvedWarehouseId = wh ? wh._id : a.warehouseId || null;

          const areaName = pickLocalizedField(a, "name", normalizedLang) || null;

          return {
            code: a.code || null,
            name: areaName,
            warehouseId: resolvedWarehouseId,
          };
        }),
      };
    });

    return {
      governorates,
      defaultWarehouse: defaultWarehouse
        ? {
            id: defaultWarehouse._id,
            name: defaultWarehouse.name,
            governorate: defaultWarehouse.governorate || null,
            isDefault: Boolean(defaultWarehouse.isDefault),
            defaultShippingPrice: defaultWarehouse.defaultShippingPrice ?? 0,
          }
        : null,
    };
  });

  return result;
}
