import asyncHandler from "express-async-handler";
import {
  getServiceCatalogService,
  getServiceByTypeService,
  createServiceAdminService,
  updateServiceAdminService,
  deleteServiceAdminService,
} from "./serviceCatalog.service.js";

// ─── Public (optionalProtect → admin sees both en/ar) ────────────────────────

export const getServiceCatalog = asyncHandler(async (req, res) => {
  const data = await getServiceCatalogService(req.lang, req.user || null);
  res.status(200).json({ data });
});

export const getServiceByType = asyncHandler(async (req, res) => {
  const data = await getServiceByTypeService(
    req.params.type,
    req.lang,
    req.user || null,
  );
  res.status(200).json({ data });
});

// ─── Admin CRUD ──────────────────────────────────────────────────────────────

export const createServiceAdmin = asyncHandler(async (req, res) => {
  const service = await createServiceAdminService(req.body, req.file);
  res.status(201).json({ data: service });
});

export const updateServiceAdmin = asyncHandler(async (req, res) => {
  const service = await updateServiceAdminService(
    req.params.type,
    req.body,
    req.file,
  );
  res.status(200).json({ data: service });
});

export const deleteServiceAdmin = asyncHandler(async (req, res) => {
  await deleteServiceAdminService(req.params.type);
  res.status(200).json({ message: "Service deleted successfully" });
});
