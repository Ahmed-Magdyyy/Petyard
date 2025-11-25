import { ZoneModel } from "../zone/zone.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { GOVERNORATES, SUPPORTED_GOVERNORATES } from "../../shared/constants/enums.js";

function normalizeGovernorateName(raw) {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.toLowerCase().trim();

  const mappings = [
    { code: GOVERNORATES.CAIRO, keys: ["cairo"] },
    { code: GOVERNORATES.ALEXANDRIA, keys: ["alexandria", "aleksandria", "alex"] },
    { code: GOVERNORATES.GIZA, keys: ["giza", "gizah"] },
    { code: GOVERNORATES.DAKAHLIA, keys: ["dakahlia", "daqahlia", "ad daqahliyah"] },
    { code: GOVERNORATES.RED_SEA, keys: ["red sea", "al bahr al ahmar"] },
    { code: GOVERNORATES.BEHEIRA, keys: ["beheira", "behira", "al buhayrah"] },
    { code: GOVERNORATES.FAYOUM, keys: ["fayoum", "faiyum", "fayum", "al fayyum"] },
    { code: GOVERNORATES.GHARBIA, keys: ["gharbia", "gharbiya", "al gharbiyah"] },
    { code: GOVERNORATES.ISMAILIA, keys: ["ismailia", "ismailiya", "al ismaliyah"] },
    { code: GOVERNORATES.MONUFIA, keys: ["monufia", "menoufia", "minufiya"] },
    { code: GOVERNORATES.MINYA, keys: ["minya", "minia", "al minya"] },
    { code: GOVERNORATES.QALYUBIA, keys: ["qalyubia", "qaliubiya", "al qalyubiyah"] },
    { code: GOVERNORATES.NEW_VALLEY, keys: ["new valley", "al wadi al jadid", "el wadi el gedid"] },
    { code: GOVERNORATES.NORTH_SINAI, keys: ["north sinai", "shamal sina"] },
    { code: GOVERNORATES.PORT_SAID, keys: ["port said", "bur sa'id"] },
    { code: GOVERNORATES.SHARQIA, keys: ["sharqia", "sharqiya", "ash sharqiyah"] },
    { code: GOVERNORATES.SOHAG, keys: ["sohag", "suhag"] },
    { code: GOVERNORATES.SOUTH_SINAI, keys: ["south sinai", "janub sina"] },
    { code: GOVERNORATES.DAMIETTA, keys: ["damietta", "dumiyat"] },
    { code: GOVERNORATES.KAFR_EL_SHEIKH, keys: ["kafr el sheikh", "kafr ash sheikh", "kafr el-shaykh"] },
    { code: GOVERNORATES.MATROUH, keys: ["matrouh", "matruh", "marsa matrouh", "marsamatruh"] },
    { code: GOVERNORATES.LUXOR, keys: ["luxor", "al uqsur"] },
    { code: GOVERNORATES.QENA, keys: ["qena", "qina"] },
    { code: GOVERNORATES.ASYUT, keys: ["asyut", "assiut", "asuyt"] },
    { code: GOVERNORATES.BENI_SUEF, keys: ["beni suef", "bani suwayf"] },
    { code: GOVERNORATES.ASWAN, keys: ["aswan", "aswan governorate"] },
    { code: GOVERNORATES.SUEZ, keys: ["suez", "as suways"] },
  ];

  for (const { code, keys } of mappings) {
    if (keys.some((k) => value.includes(k))) {
      return code;
    }
  }

  return null;
}

async function findZoneForPoint({ latNum, lngNum }) {
  const point = {
    type: "Point",
    coordinates: [lngNum, latNum],
  };

  const zone = await ZoneModel.findOne({
    geometry: {
      $geoIntersects: {
        $geometry: point,
      },
    },
  }).populate("warehouse", "name code governorate active defaultShippingPrice isDefault");

  return zone;
}

async function findWarehouseByGovernorate(governorate) {
  if (!governorate) return null;

  const warehouse = await WarehouseModel.findOne({
    governorate,
    active: true,
  }).sort({ createdAt: 1 });

  return warehouse;
}

async function findDefaultWarehouse() {
  let warehouse = await WarehouseModel.findOne({ isDefault: true, active: true });

  if (!warehouse) {
    warehouse = await WarehouseModel.findOne({ active: true }).sort({ createdAt: 1 });
  }

  return warehouse;
}

function buildZoneBasedResponse({ zone, latNum, lngNum, source, governorateRaw, normalizedGovFromClient }) {
  const warehouse = zone.warehouse;

  if (!warehouse) {
    throw new ApiError("Zone is not linked to a warehouse", 500);
  }

  const isZoneActive = Boolean(zone.active);
  const zoneColor = isZoneActive ? "green" : "grey";

  const effectiveShippingPrice =
    zone.shippingFee &&
    typeof zone.shippingFee === "number" &&
    !Number.isNaN(zone.shippingFee)
      ? zone.shippingFee
      : warehouse.defaultShippingPrice ?? 0;

  const normalizedFromWarehouse = warehouse.governorate || null;
  const normalized = normalizedGovFromClient || normalizedFromWarehouse;
  const isSupported = !!normalized && SUPPORTED_GOVERNORATES.includes(normalized);

  let coverageStatus;
  let reasonCode = null;
  let reasonMessage = null;
  let canDeliver;

  if (isZoneActive) {
    coverageStatus = "GREEN_ZONE";
    canDeliver = true;
  } else {
    coverageStatus = "GREY_ZONE";
    canDeliver = false;
    reasonCode = "NON_DELIVERABLE_GREY_ZONE";
    reasonMessage = "We currently don't deliver to this area.";
  }

  return {
    warehouse: {
      id: warehouse._id,
      name: warehouse.name,
      governorate: warehouse.governorate || null,
      isDefault: Boolean(warehouse.isDefault),
      defaultShippingPrice: warehouse.defaultShippingPrice ?? 0,
    },
    location: {
      source: source || "gps",
      coordinates: {
        lat: latNum,
        lng: lngNum,
      },
      zone: {
        id: zone._id,
        color: zoneColor,
        name: zone.name || null,
        areaName: zone.areaName || null,
      },
      governorate: {
        raw: governorateRaw || null,
        normalized,
        isSupported,
      },
    },
    delivery: {
      canDeliver,
      coverageStatus,
      reasonCode,
      reasonMessage,
      effectiveShippingPrice,
      shippingFee: zone.shippingFee ?? null,
      defaultShippingPrice: warehouse.defaultShippingPrice ?? 0,
    },
  };
}

function buildOutsideZonesResponse({
  warehouse,
  latNum,
  lngNum,
  source,
  governorateRaw,
  normalizedGov,
  isSupported,
  coverageStatus,
  reasonCode,
  reasonMessage,
}) {
  if (!warehouse) {
    throw new ApiError("No active warehouse configured", 500);
  }

  const effectiveShippingPrice = warehouse.defaultShippingPrice ?? 0;

  return {
    warehouse: {
      id: warehouse._id,
      name: warehouse.name,
      governorate: warehouse.governorate || null,
      isDefault: Boolean(warehouse.isDefault),
      defaultShippingPrice: warehouse.defaultShippingPrice ?? 0,
    },
    location: {
      source: source || "gps",
      coordinates: {
        lat: latNum,
        lng: lngNum,
      },
      zone: {
        id: null,
        color: null,
        name: null,
        areaName: null,
      },
      governorate: {
        raw: governorateRaw || null,
        normalized: normalizedGov,
        isSupported,
      },
    },
    delivery: {
      canDeliver: false,
      coverageStatus,
      reasonCode,
      reasonMessage,
      effectiveShippingPrice,
      shippingFee: null,
      defaultShippingPrice: warehouse.defaultShippingPrice ?? 0,
    },
  };
}

export async function resolveLocationByCoordinatesService({ lat, lng, governorateRaw, source = "gps" }) {
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    throw new ApiError("lat and lng must be numbers", 400);
  }

  const normalizedGovFromClient = normalizeGovernorateName(governorateRaw);

  const zone = await findZoneForPoint({ latNum, lngNum });

  if (zone) {
    return buildZoneBasedResponse({
      zone,
      latNum,
      lngNum,
      source,
      governorateRaw,
      normalizedGovFromClient,
    });
  }

  const normalizedGov = normalizedGovFromClient;
  const isSupported = !!normalizedGov && SUPPORTED_GOVERNORATES.includes(normalizedGov);

  if (isSupported) {
    let warehouse = await findWarehouseByGovernorate(normalizedGov);

    if (!warehouse) {
      warehouse = await findDefaultWarehouse();
    }

    return buildOutsideZonesResponse({
      warehouse,
      latNum,
      lngNum,
      source,
      governorateRaw,
      normalizedGov,
      isSupported,
      coverageStatus: "OUTSIDE_ZONES_SUPPORTED_GOVERNORATE",
      reasonCode: "NON_DELIVERABLE_OUTSIDE_GRID",
      reasonMessage:
        "We currently don't deliver to this exact area, but you can still browse products.",
    });
  }

  const warehouse = await findDefaultWarehouse();
  const normalizedFallbackGov = warehouse?.governorate || null;
  const isFallbackSupported = !!normalizedFallbackGov &&
    SUPPORTED_GOVERNORATES.includes(normalizedFallbackGov);

  return buildOutsideZonesResponse({
    warehouse,
    latNum,
    lngNum,
    source,
    governorateRaw,
    normalizedGov: normalizedGov || normalizedFallbackGov || null,
    isSupported: isSupported || isFallbackSupported,
    coverageStatus: "OUTSIDE_ZONES_UNSUPPORTED_GOVERNORATE",
    reasonCode: "NON_DELIVERABLE_UNSUPPORTED_GOVERNORATE",
    reasonMessage:
      "We currently don't deliver to this governorate. You can still browse products.",
  });
}

export async function getLocationOptionsService() {
  const aggregate = await ZoneModel.aggregate([
    {
      $match: {
        active: true,
        areaName: { $exists: true, $ne: "" },
      },
    },
    {
      $group: {
        _id: { governorate: "$governorate", areaName: "$areaName" },
        warehouse: { $first: "$warehouse" },
      },
    },
  ]);

  const byGovernorate = new Map();

  aggregate.forEach((row) => {
    const gov = (row._id?.governorate || "").toLowerCase();
    const areaName = row._id?.areaName;
    if (!gov || !areaName) return;

    if (!byGovernorate.has(gov)) {
      byGovernorate.set(gov, []);
    }
    byGovernorate.get(gov).push({
      name: areaName,
      warehouseId: row.warehouse,
    });
  });

  const governorateLabels = {
    [GOVERNORATES.ALEXANDRIA]: "Alexandria",
    [GOVERNORATES.CAIRO]: "Cairo",
    [GOVERNORATES.GIZA]: "Giza",
  };

  const governorates = SUPPORTED_GOVERNORATES.map((code) => {
    const areas = byGovernorate.get(code) || [];

    return {
      code,
      label: governorateLabels[code] || code,
      hasAreas: areas.length > 0,
      areas,
    };
  });

  return {
    governorates,
  };
}
