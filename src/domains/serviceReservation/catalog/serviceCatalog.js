import { ApiError } from "../../../shared/ApiError.js";
import { serviceTypeEnum } from "../../../shared/constants/enums.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";

const CURRENCY = "EGP";

const CATALOG = Object.freeze({
  [serviceTypeEnum.GROOMING]: {
    type: serviceTypeEnum.GROOMING,
    name_en: "Grooming",
    name_ar: "جروومينج",
    options: [
      {
        key: "cat",
        name_en: "Cat",
        name_ar: "",
        price: 250,
      },
      {
        key: "dog",
        name_en: "Dog",
        name_ar: "",
        price: 300,
      },
    ],
  },
  [serviceTypeEnum.SHOWERING]: {
    type: serviceTypeEnum.SHOWERING,
    name_en: "Showering",
    name_ar: "استحمام",
    options: [
      {
        key: "normal",
        name_en: "Normal",
        name_ar: "استحمام عادى",
        price: 180,
      },
      {
        key: "medical_chemical",
        name_en: "Medical/Chemical",
        name_ar: "استحمام طبى",
        price: 250,
      },
    ],
  },
  [serviceTypeEnum.CLINIC]: {
    type: serviceTypeEnum.CLINIC,
    name_en: "Clinic Check Up",
    name_ar: "كشف طبى",
    options: [
      {
        key: "checkup",
        name_en: "Check Up",
        name_ar: "كشف طبى",
        price: 75,
      },
    ],
  },
});

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

export function getServiceCatalog(lang = "en") {
  const normalizedLang = normalizeLang(lang);

  return Object.values(CATALOG).map((svc) => ({
    type: svc.type,
    name: pickLocalizedField(svc, "name", normalizedLang),
    options: (svc.options || []).map((opt) => ({
      key: opt.key,
      name: pickLocalizedField(opt, "name", normalizedLang),
      price: opt.price,
      currency: CURRENCY,
    })),
  }));
}

export function getServiceDefinition(serviceType) {
  return CATALOG[serviceType] || null;
}

export function resolveServiceSelectionOrThrow({ serviceType, optionKey }) {
  const svc = getServiceDefinition(serviceType);
  if (!svc) {
    throw new ApiError("Invalid serviceType", 400);
  }

  const options = svc.options || [];
  const selectedKey =
    optionKey != null && String(optionKey).trim() ? String(optionKey).trim() : null;

  if (serviceType === serviceTypeEnum.GROOMING || serviceType === serviceTypeEnum.SHOWERING) {
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

export function getServiceNameFallback(serviceType, lang) {
  const svc = getServiceDefinition(serviceType);
  if (!svc) return "";
  return pickLocalizedField(svc, "name", normalizeLang(lang));
}

export function getServiceOptionNameFallback(serviceType, optionKey, lang) {
  const svc = getServiceDefinition(serviceType);
  if (!svc) return "";

  const options = svc.options || [];
  const opt = options.find((o) => o.key === optionKey);
  if (!opt) return "";
  return pickLocalizedField(opt, "name", normalizeLang(lang));
}
