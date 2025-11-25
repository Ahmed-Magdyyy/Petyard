// src/domains/zone/zone.service.js
import { ZoneModel } from "./zone.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { buildPagination, buildSort } from "../../shared/utils/apiFeatures.js";
import { polygon as turfPolygon, area as turfArea, hexGrid } from "@turf/turf";

export async function getZonesService(queryParams = {}) {
  const { page, limit, warehouse, country, governorate, city, district, active } =
    queryParams;

  const filter = {};

  if (warehouse) {
    filter.warehouse = warehouse;
  }

  if (country) {
    filter.country = { $regex: country, $options: "i" };
  }
  if (governorate) {
    filter.governorate = { $regex: governorate, $options: "i" };
  }
  if (city) {
    filter.city = { $regex: city, $options: "i" };
  }
  if (district) {
    filter.district = { $regex: district, $options: "i" };
  }

  if (active !== undefined) {
    if (active === "true" || active === "1" || active === true) {
      filter.active = true;
    } else if (active === "false" || active === "0" || active === false) {
      filter.active = false;
    }
  }

  const totalCount = await ZoneModel.countDocuments(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 50);
  const sort = buildSort(queryParams, "name");

  const q = ZoneModel.find(filter)
    .populate("warehouse", "name code active")
    .skip(skip)
    .limit(limitNum);

  if (sort) {
    q.sort(sort);
  }

  const zones = await q;
  const totalPages = Math.ceil(totalCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: zones.length,
    data: zones,
  };
}

export async function getZoneByIdService(id) {
  const zone = await ZoneModel.findById(id).populate("warehouse", "name code active");
  if (!zone) {
    throw new ApiError(`No zone found for this id: ${id}`, 404);
  }
  return zone;
}

async function assertWarehouseExists(warehouseId) {
  const exists = await WarehouseModel.exists({ _id: warehouseId });
  if (!exists) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 400);
  }
}

function validateZoneGeometryOrThrow(geometry) {
  if (!geometry) return;

  try {
    const poly = turfPolygon(geometry.coordinates);
    const polyArea = turfArea(poly);

    if (!polyArea || polyArea <= 0) {
      throw new ApiError("Zone geometry has zero area", 400);
    }
  } catch (err) {
    throw new ApiError("Invalid zone geometry", 400);
  }
}

export async function createZoneService(payload) {
  const { warehouse, geometry, ...rest } = payload;

  await assertWarehouseExists(warehouse);

  validateZoneGeometryOrThrow(geometry);

  const warehouseDoc = await WarehouseModel.findById(warehouse).select("governorate");

  const zone = await ZoneModel.create({
    ...rest,
    warehouse,
    geometry,
    governorate: warehouseDoc?.governorate,
  });

  return zone;
}

export async function updateZoneService(id, payload) {
  const zone = await ZoneModel.findById(id);
  if (!zone) {
    throw new ApiError(`No zone found for this id: ${id}`, 404);
  }

  const { name, areaName, country, warehouse, shippingFee, active, geometry } = payload;

  if (name !== undefined) zone.name = name;
  if (areaName !== undefined) zone.areaName = areaName;
  if (country !== undefined) zone.country = country;
  if (shippingFee !== undefined) zone.shippingFee = shippingFee;

  if (warehouse !== undefined) {
    await assertWarehouseExists(warehouse);
    zone.warehouse = warehouse;

    const warehouseDoc = await WarehouseModel.findById(warehouse).select("governorate");
    zone.governorate = warehouseDoc?.governorate;
  }

  if (geometry !== undefined) {
    validateZoneGeometryOrThrow(geometry);
    zone.geometry = geometry;
  }

  if (active !== undefined) zone.active = active;

  const updated = await zone.save();
  return updated;
}

export async function toggleZoneActiveService(id) {
  const zone = await ZoneModel.findById(id);
  if (!zone) {
    throw new ApiError(`No zone found for this id: ${id}`, 404);
  }

  zone.active = !zone.active;
  const updated = await zone.save();
  return updated;
}

export async function deleteZoneService(id) {
  const zone = await ZoneModel.findById(id);
  if (!zone) {
    throw new ApiError(`No zone found for this id: ${id}`, 404);
  }

  // TODO: later, prevent delete if zone is referenced by orders/addresses

  await ZoneModel.deleteOne({ _id: id });
}

export async function generateWarehouseGridService(
  warehouseId,
  { radiusKm = 10, cellSideKm = 1, overwrite = false } = {}
) {
  const warehouse = await WarehouseModel.findById(warehouseId);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 404);
  }

  if (!warehouse.location || !Array.isArray(warehouse.location.coordinates)) {
    throw new ApiError(
      "Warehouse location is not set. Please set location before generating zones grid.",
      400
    );
  }

  const existingZonesCount = await ZoneModel.countDocuments({ warehouse: warehouseId });

  if (existingZonesCount > 0 && !overwrite) {
    throw new ApiError(
      "Zones already exist for this warehouse. Use overwrite=true to regenerate the grid.",
      400
    );
  }

  if (overwrite && existingZonesCount > 0) {
    await ZoneModel.deleteMany({ warehouse: warehouseId });
  }

  const [lng, lat] = warehouse.location.coordinates;

  const safeLat = typeof lat === "number" ? lat : 0;
  const latRad = (safeLat * Math.PI) / 180;
  const latDelta = radiusKm / 111.0;
  const lonDenom = 111.0 * Math.cos(latRad) || 1;
  const lonDelta = radiusKm / lonDenom;

  const bbox = [
    lng - lonDelta,
    lat - latDelta,
    lng + lonDelta,
    lat + latDelta,
  ];

  const grid = hexGrid(bbox, cellSideKm, { units: "kilometers" });

  if (!grid || !Array.isArray(grid.features) || grid.features.length === 0) {
    throw new ApiError("Failed to generate hex grid for the given parameters", 400);
  }

  const docs = grid.features
    .filter((feature) => feature && feature.geometry)
    .map((feature, index) => ({
      name: `${warehouse.code || "WH"}-cell-${index + 1}`,
      warehouse: warehouseId,
      governorate: warehouse.governorate,
      geometry: feature.geometry,
      active: false,
    }));

  if (!docs.length) {
    throw new ApiError("No valid hex cells generated for this warehouse", 400);
  }

  const zones = await ZoneModel.insertMany(docs);

  return {
    total: zones.length,
    radiusKm,
    cellSideKm,
    data: zones,
  };
}

export async function getWarehouseZonesGridService(warehouseId) {
  const zones = await ZoneModel.find({ warehouse: warehouseId }).sort({ name: 1 });

  return {
    results: zones.length,
    data: zones,
  };
}

export async function updateWarehouseZonesGridService(warehouseId, { zones }) {
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new ApiError("zones must be a non-empty array", 400);
  }

  const ids = zones.map((z) => z.id);

  const existingCount = await ZoneModel.countDocuments({
    _id: { $in: ids },
    warehouse: warehouseId,
  });

  if (existingCount !== ids.length) {
    throw new ApiError(
      "One or more zones do not belong to the specified warehouse",
      400
    );
  }

  const bulkOps = [];

  zones.forEach((zonePayload) => {
    const { id, _action, active, name, shippingFee, areaName } = zonePayload;

    if (_action !== "update") return;

    const set = {};
    const unset = {};

    if (typeof active === "boolean") {
      set.active = active;
    }

    if (typeof name === "string") {
      set.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(zonePayload, "shippingFee")) {
      if (shippingFee === null || typeof shippingFee === "undefined" || shippingFee === "" || shippingFee === 0) {
        unset.shippingFee = "";
      } else {
        set.shippingFee = shippingFee;
      }
    }

    if (Object.prototype.hasOwnProperty.call(zonePayload, "areaName")) {
      if (areaName === null || typeof areaName === "undefined" || areaName === "") {
        unset.areaName = "";
      } else if (typeof areaName === "string") {
        set.areaName = areaName;
      }
    }

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;

    if (!Object.keys(update).length) return;

    bulkOps.push({
      updateOne: {
        filter: { _id: id, warehouse: warehouseId },
        update,
      },
    });
  });

  if (!bulkOps.length) {
    return {
      modifiedCount: 0,
      data: await ZoneModel.find({ warehouse: warehouseId }).sort({ name: 1 }),
    };
  }

  const result = await ZoneModel.bulkWrite(bulkOps);

  const updatedZones = await ZoneModel.find({ warehouse: warehouseId }).sort({ name: 1 });

  return {
    modifiedCount: result.modifiedCount || 0,
    data: updatedZones,
  };
}
