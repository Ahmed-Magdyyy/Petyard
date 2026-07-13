import { HomeLayoutModel } from "./homeLayout.model.js";
import { enabledControls, roles } from "../../shared/constants/enums.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";

const HOME_LAYOUT_CACHE_VERSION_KEY = "home-layout:version";
const HOME_LAYOUT_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.HOME_LAYOUT_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);

const DEFAULT_SECTIONS = [
  {
    key: "banners",
    name_en: "Banners",
    name_ar: "البانرات",
    position: 0,
    isVisible: true,
  },
  {
    key: "services",
    name_en: "Services",
    name_ar: "الخدمات",
    position: 1,
    isVisible: true,
  },
  {
    key: "collections",
    name_en: "Collections",
    name_ar: "المجموعات",
    position: 2,
    isVisible: true,
  },
  {
    key: "recommended",
    name_en: "Recommended",
    name_ar: "موصى به",
    position: 3,
    isVisible: true,
  },
  {
    key: "categories",
    name_en: "Categories",
    name_ar: "الأقسام",
    position: 4,
    isVisible: true,
  },
  {
    key: "shopByUserPet",
    name_en: "Shop By Pet",
    name_ar: "مناسب للحيوان الخاص بك",
    position: 5,
    isVisible: true,
  },
];

async function getOrCreateLayout() {
  let layout = await HomeLayoutModel.findOne();
  if (!layout) {
    layout = await HomeLayoutModel.create({ sections: DEFAULT_SECTIONS });
  }
  return layout;
}

export async function getHomeLayoutService(lang = "en", user = null) {
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.HOME_LAYOUT)));
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const fetchLayout = async () => {
    const layout = await getOrCreateLayout();

    const sorted = [...layout.sections].sort((a, b) => a.position - b.position);

    const sections = sorted.map((s) => ({
      key: s.key,
      ...(includeAllLanguages
        ? {
            name: normalizedLang === "ar" ? s.name_ar : s.name_en,
            name_en: s.name_en,
            name_ar: s.name_ar,
          }
        : { name: normalizedLang === "ar" ? s.name_ar : s.name_en }),
      position: s.position,
      // isVisible: s.isVisible,
    }));

    return { sections };
  };

  if (includeAllLanguages) {
    return fetchLayout();
  }

  const version = await getCacheVersion(HOME_LAYOUT_CACHE_VERSION_KEY);
  return getOrSetCache(
    `home-layout:v1:${version}:${normalizedLang}`,
    HOME_LAYOUT_CACHE_TTL_SECONDS,
    fetchLayout,
  );
}

export async function updateHomeLayoutService(sections) {
  const layout = await getOrCreateLayout();

  const updatesByKey = {};
  sections.forEach((s, index) => {
    updatesByKey[s.key] = {
      position: typeof s.position === "number" ? s.position : index,
    };
  });

  layout.sections = layout.sections.map((s) => {
    const update = updatesByKey[s.key];
    if (update) {
      s.position = update.position;
    }
    return s;
  });

  const updated = await layout.save();
  await bumpCacheVersion(HOME_LAYOUT_CACHE_VERSION_KEY);

  const sorted = [...updated.sections].sort((a, b) => a.position - b.position);

  return {
    sections: sorted.map((s) => ({
      key: s.key,
      name_en: s.name_en,
      name_ar: s.name_ar,
      position: s.position,
      isVisible: s.isVisible,
    })),
  };
}
