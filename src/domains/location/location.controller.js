// src/domains/location/location.controller.js
import asyncHandler from "express-async-handler";
import {
  resolveLocationByCoordinatesService,
  getLocationOptionsService,
} from "./location.service.js";

// POST /locations/resolve
export const resolveLocation = asyncHandler(async (req, res) => {
  const { lat, lng, governorateCode, areaCode } = req.body || {};

  const result = await resolveLocationByCoordinatesService({
    lat,
    lng,
    governorateCode,
    areaCode,
  });

  res.status(200).json({ data: result });
});

// GET /locations/options
export const getLocationOptions = asyncHandler(async (req, res) => {
  const result = await getLocationOptionsService(req.lang);
  res.status(200).json({ data: result });
});
