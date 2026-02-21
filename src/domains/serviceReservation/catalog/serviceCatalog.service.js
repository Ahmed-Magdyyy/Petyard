import { ServiceCatalogModel } from "./serviceCatalog.model.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { roles, enabledControls } from "../../../shared/constants/enums.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../../shared/utils/imageUpload.js";

const CURRENCY = "EGP";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function isAdminUser(user) {
  if (!user) return false;
  return (
    user.role === roles.SUPER_ADMIN ||
    (user.role === roles.ADMIN &&
      user.enabledControls?.includes(enabledControls.SERVICE_RESERVATIONS))
  );
}

// ─── Public / Shared lookups ─────────────────────────────────────────────────

export async function getServiceCatalogService(lang = "en", user = null) {
  const normalizedLang = normalizeLang(lang);
  const includeAllLanguages = isAdminUser(user);

  const services = await ServiceCatalogModel.find({ isActive: true }).sort({
    createdAt: 1,
  });

  return services.map((svc) => ({
    type: svc.type,
    ...(includeAllLanguages
      ? {
          name_en: svc.name_en,
          name_ar: svc.name_ar,
        }
      : {
          name: pickLocalizedField(svc, "name", normalizedLang),
        }),
    image: svc.image?.url || null,
    options: (svc.options || []).map((opt) => ({
      key: opt.key,
      ...(includeAllLanguages
        ? {
            name_en: opt.name_en,
            name_ar: opt.name_ar,
          }
        : {
            name: pickLocalizedField(opt, "name", normalizedLang),
          }),
      price: opt.price,
      currency: CURRENCY,
    })),
  }));
}

export async function getServiceDefinition(serviceType) {
  const svc = await ServiceCatalogModel.findOne({ type: serviceType }).lean();
  return svc || null;
}

export async function resolveServiceSelectionOrThrow({
  serviceType,
  optionKey,
}) {
  const svc = await getServiceDefinition(serviceType);
  if (!svc) {
    throw new ApiError("Invalid serviceType", 400);
  }

  const options = svc.options || [];
  const selectedKey =
    optionKey != null && String(optionKey).trim()
      ? String(optionKey).trim()
      : null;

  if (serviceType === "GROOMING" || serviceType === "SHOWERING") {
    if (!selectedKey) {
      throw new ApiError("serviceOptionKey is required for this service", 400);
    }
  }

  let opt = null;
  if (selectedKey) {
    opt = options.find((o) => o.key === selectedKey) || null;
    if (!opt) {
      throw new ApiError("Invalid serviceOptionKey", 400);
    }
  } else {
    if (options.length === 1) {
      opt = options[0];
    } else if (options.length > 1) {
      throw new ApiError("serviceOptionKey is required for this service", 400);
    }
  }

  if (!opt) {
    throw new ApiError("Unable to resolve service option", 400);
  }

  return {
    serviceType: svc.type,
    serviceName_en: svc.name_en,
    serviceName_ar: svc.name_ar,
    serviceOptionKey: opt.key,
    serviceOptionName_en: opt.name_en,
    serviceOptionName_ar: opt.name_ar,
    servicePrice: opt.price,
    currency: CURRENCY,
  };
}

export async function getServiceNameFallback(serviceType, lang) {
  const svc = await getServiceDefinition(serviceType);
  if (!svc) return "";
  return pickLocalizedField(svc, "name", normalizeLang(lang));
}

export async function getServiceOptionNameFallback(
  serviceType,
  optionKey,
  lang,
) {
  const svc = await getServiceDefinition(serviceType);
  if (!svc) return "";

  const options = svc.options || [];
  const opt = options.find((o) => o.key === optionKey);
  if (!opt) return "";
  return pickLocalizedField(opt, "name", normalizeLang(lang));
}

// ─── Admin CRUD ──────────────────────────────────────────────────────────────

export async function getServiceByTypeService(type, lang = "en", user = null) {
  const normalizedLang = normalizeLang(lang);
  const includeAllLanguages = isAdminUser(user);

  const svc = await ServiceCatalogModel.findOne({ type: type.toUpperCase() });
  if (!svc) {
    throw new ApiError(`No service found for type: ${type}`, 404);
  }

  return {
    type: svc.type,
    ...(includeAllLanguages
      ? {
          name_en: svc.name_en,
          name_ar: svc.name_ar,
        }
      : {
          name: pickLocalizedField(svc, "name", normalizedLang),
        }),
    image: svc.image?.url || null,
    isActive: svc.isActive,
    options: (svc.options || []).map((opt) => ({
      key: opt.key,
      ...(includeAllLanguages
        ? {
            name_en: opt.name_en,
            name_ar: opt.name_ar,
          }
        : {
            name: pickLocalizedField(opt, "name", normalizedLang),
          }),
      price: opt.price,
      currency: CURRENCY,
    })),
    createdAt: svc.createdAt,
    updatedAt: svc.updatedAt,
  };
}

export async function createServiceAdminService(payload, file) {
  const { type, name_en, name_ar, isActive, options } = payload;

  const existing = await ServiceCatalogModel.findOne({
    type: type.toUpperCase(),
  });
  if (existing) {
    throw new ApiError(
      `Service with type '${type.toUpperCase()}' already exists`,
      409,
    );
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/services",
      publicId: `service_${type.toLowerCase()}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  // Parse options if it came as a JSON string (multipart/form-data)
  let parsedOptions = options;
  if (typeof options === "string") {
    try {
      parsedOptions = JSON.parse(options);
    } catch {
      throw new ApiError("options must be a valid JSON array", 400);
    }
  }

  try {
    const service = await ServiceCatalogModel.create({
      type: type.toUpperCase(),
      name_en,
      name_ar,
      ...(image && { image }),
      ...(typeof isActive === "boolean" && { isActive }),
      ...(parsedOptions && { options: parsedOptions }),
    });

    return service;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function updateServiceAdminService(serviceType, payload, file) {
  const service = await ServiceCatalogModel.findOne({
    type: serviceType.toUpperCase(),
  });
  if (!service) {
    throw new ApiError(`No service found for type: ${serviceType}`, 404);
  }

  const { type: newType, name_en, name_ar, isActive, options } = payload;

  if (newType !== undefined) service.type = newType.toUpperCase();
  if (name_en !== undefined) service.name_en = name_en;
  if (name_ar !== undefined) service.name_ar = name_ar;
  if (isActive !== undefined) service.isActive = isActive;

  if (options !== undefined) {
    let parsedOptions = options;
    if (typeof options === "string") {
      try {
        parsedOptions = JSON.parse(options);
      } catch {
        throw new ApiError("options must be a valid JSON array", 400);
      }
    }
    service.options = parsedOptions;
  }

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = service.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/services",
      publicId: `service_${service.type.toLowerCase()}_${Date.now()}`,
    });
    service.image = newImage;
  }

  try {
    const updated = await service.save();

    if (oldPublicId) {
      await deleteImageFromCloudinary(oldPublicId);
    }

    return updated;
  } catch (err) {
    if (newImage?.public_id) {
      await deleteImageFromCloudinary(newImage.public_id);
    }
    throw err;
  }
}

export async function deleteServiceAdminService(type) {
  const service = await ServiceCatalogModel.findOne({
    type: type.toUpperCase(),
  });
  if (!service) {
    throw new ApiError(`No service found for type: ${type}`, 404);
  }

  if (service.image?.public_id) {
    await deleteImageFromCloudinary(service.image.public_id);
  }

  await ServiceCatalogModel.deleteOne({ type: type.toUpperCase() });
}
