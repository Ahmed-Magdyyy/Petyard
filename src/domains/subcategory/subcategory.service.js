import { SubcategoryModel } from "./subcategory.model.js";
import { CategoryModel } from "../category/category.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { enabledControls, roles } from "../../shared/constants/enums.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
  stableStringify,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import {
  IMAGE_DELIVERY_CACHE_NAMESPACE,
  IMAGE_DELIVERY_PRESETS,
  getImageDeliveryUrl,
} from "../../shared/utils/imageDelivery.js";
import { bumpProductListCacheVersion } from "../product/productCache.service.js";
import {
  validateImageFile,
  uploadImage,
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";
import { buildFlexibleSearchPattern } from "../../shared/utils/escapeRegex.js";
import {
  cleanupSubscriptionsForSubcategory,
  getSubscribedSubcategoryIdsForIdentity,
  isUserSubscribedToSubcategory,
} from "../subcategorySubscription/subcategorySubscription.service.js";

const SUBCATEGORY_CACHE_VERSION_KEY = "subcategories:version";
const SUBCATEGORY_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.SUBCATEGORY_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);

async function invalidateSubcategoryCaches() {
  await Promise.all([
    bumpCacheVersion(SUBCATEGORY_CACHE_VERSION_KEY),
    bumpProductListCacheVersion(),
  ]);
}

function addSubscriptionState(nodes, subscribedIds) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => ({
    ...node,
    isSubscribed: subscribedIds.has(String(node.id)),
    children: Array.isArray(node.children)
      ? addSubscriptionState(node.children, subscribedIds)
      : node.children,
  }));
}

export function mapSubcategoryToListDto(
  subcategory,
  { lang = "en", includeAllLanguages = false } = {},
) {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  return {
    id: subcategory._id,
    category: subcategory.category?._id || subcategory.category,
    slug: subcategory.slug,
    updatedAt: subcategory.updatedAt,
    ...(includeAllLanguages
      ? {
          name: pickLocalizedField(subcategory, "name", normalizedLang),
          name_en: subcategory.name_en,
          name_ar: subcategory.name_ar,
          desc: pickLocalizedField(subcategory, "desc", normalizedLang),
          desc_en: subcategory.desc_en,
          desc_ar: subcategory.desc_ar,
        }
      : {
          name: pickLocalizedField(subcategory, "name", normalizedLang),
          desc: pickLocalizedField(subcategory, "desc", normalizedLang),
        }),
    image: getImageDeliveryUrl(
      subcategory.image?.url || null,
      IMAGE_DELIVERY_PRESETS.SUBCATEGORY_TILE,
    ),
    parent: subcategory.parent?._id || subcategory.parent || null,
    children: [],
  };
}

export async function getSubcategoriesService(
  query = {},
  lang = "en",
  user = null,
  guestId = null,
) {
  const { category, subcategory: parentId, q } = query;
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.SUBCATEGORIES)));

  const filter = {};
  if (category) {
    filter.category = category;
  }

  const fetchSubcategories = async () => {
    // Fetch all subcategories for the category (we need the full list to build the tree)
    const allSubcategories = await SubcategoryModel.find(filter)
      .populate("category", "_id slug name_en name_ar")
      .populate("parent", "_id slug name_en name_ar")
      .sort({ createdAt: 1 });

    // When q is provided, determine which subcategories match and which
    // ancestors are needed to preserve the tree structure.
    let matchFilter = null;
    if (typeof q === "string" && q.trim()) {
      const regex = new RegExp(
        buildFlexibleSearchPattern(q.trim()),
        "i",
      );
      // Collect IDs of subcategories whose name matches the query
      const matchedIds = new Set();
      for (const s of allSubcategories) {
        if (regex.test(s.name_en) || regex.test(s.name_ar)) {
          matchedIds.add(String(s._id));
        }
      }
      // Also include all ancestors of matched nodes so the tree stays intact
      const allById = new Map();
      for (const s of allSubcategories) {
        allById.set(String(s._id), s);
      }
      const includedIds = new Set(matchedIds);
      for (const id of matchedIds) {
        let current = allById.get(id);
        while (current) {
          const pid = current.parent?._id
            ? String(current.parent._id)
            : current.parent
              ? String(current.parent)
              : null;
          if (!pid || includedIds.has(pid)) break;
          includedIds.add(pid);
          current = allById.get(pid);
        }
      }
      // Also include all descendants of matched nodes
      const addDescendants = (parentIdStr) => {
        for (const s of allSubcategories) {
          const pid = s.parent?._id
            ? String(s.parent._id)
            : s.parent
              ? String(s.parent)
              : null;
          if (pid === parentIdStr && !includedIds.has(String(s._id))) {
            includedIds.add(String(s._id));
            addDescendants(String(s._id));
          }
        }
      };
      for (const id of matchedIds) {
        addDescendants(id);
      }
      matchFilter = includedIds;
    }

    // Filter the list if q was provided
    const subcategories = matchFilter
      ? allSubcategories.filter((s) => matchFilter.has(String(s._id)))
      : allSubcategories;

    // Build a map of all formatted subcategories by ID
    const formatted = subcategories.map((subcategory) =>
      mapSubcategoryToListDto(subcategory, {
        lang: normalizedLang,
        includeAllLanguages,
      }),
    );
    const map = new Map();
    for (const s of formatted) {
      map.set(String(s.id), s);
    }

    // Nest children into their parents (with circular reference protection)
    const roots = [];
    for (const s of formatted) {
      const pid = s.parent ? String(s.parent) : null;
      if (pid && map.has(pid)) {
        // Walk up the ancestor chain to detect cycles
        let ancestor = pid;
        let isCycle = false;
        const visited = new Set();
        while (ancestor) {
          if (ancestor === String(s.id)) {
            isCycle = true;
            break;
          }
          if (visited.has(ancestor)) break;
          visited.add(ancestor);
          const parentNode = map.get(ancestor);
          ancestor = parentNode?.parent ? String(parentNode.parent) : null;
        }

        if (isCycle) {
          // Circular reference detected; treat as root
          roots.push(s);
        } else {
          map.get(pid).children.push(s);
        }
      } else {
        roots.push(s);
      }
    }

    // If a parent subcategory filter was provided, return only its direct branch
    if (parentId) {
      const parent = map.get(String(parentId));
      return parent ? parent.children : [];
    }

    return roots;
  };

  let data;
  if (includeAllLanguages) {
    data = await fetchSubcategories();
  } else {
    const version = await getCacheVersion(SUBCATEGORY_CACHE_VERSION_KEY);
    data = await getOrSetCache(
      `subcategories:list:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${normalizedLang}:${stableStringify(query || {})}`,
      SUBCATEGORY_CACHE_TTL_SECONDS,
      fetchSubcategories,
    );
  }

  const userId = user?._id || user?.id || null;
  const subscribedIds = userId || guestId
    ? new Set(
        await getSubscribedSubcategoryIdsForIdentity({ userId, guestId }),
      )
    : new Set();
  return addSubscriptionState(data, subscribedIds);
}

export async function getMySubscribedSubcategoriesService({
  userId,
  guestId,
  lang = "en",
} = {}) {
  const subscribedIds = await getSubscribedSubcategoryIdsForIdentity({
    userId,
    guestId,
  });
  if (!subscribedIds.length) return [];

  const subcategories = await SubcategoryModel.find({
    _id: { $in: subscribedIds },
  })
    .populate("category", "_id slug name_en name_ar")
    .populate("parent", "_id slug name_en name_ar")
    .lean();
  const subcategoryById = new Map(
    subcategories.map((subcategory) => [String(subcategory._id), subcategory]),
  );

  return subscribedIds
    .map((id) => subcategoryById.get(String(id)))
    .filter(Boolean)
    .map((subcategory) => ({
      ...mapSubcategoryToListDto(subcategory, { lang }),
      isSubscribed: true,
    }));
}

export async function getSubcategoryByIdService(
  id,
  lang = "en",
  user = null,
  guestId = null,
) {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.SUBCATEGORIES)));

  const fetchSubcategory = async () => {
    const subcategory = await SubcategoryModel.findById(id)
      .populate("category", "_id slug name_en name_ar")
      .populate("parent", "_id slug name_en name_ar");
    if (!subcategory) {
      throw new ApiError(`No subcategory found for this id: ${id}`, 404);
    }

    return {
      id: subcategory._id,
      category: subcategory.category?._id || subcategory.category,
      slug: subcategory.slug,
      updatedAt: subcategory.updatedAt,
      ...(includeAllLanguages
        ? {
            name: pickLocalizedField(subcategory, "name", normalizedLang),
            name_en: subcategory.name_en,
            name_ar: subcategory.name_ar,
            desc: pickLocalizedField(subcategory, "desc", normalizedLang),
            desc_en: subcategory.desc_en,
            desc_ar: subcategory.desc_ar,
          }
        : {
            name: pickLocalizedField(subcategory, "name", normalizedLang),
            desc: pickLocalizedField(subcategory, "desc", normalizedLang),
          }),
      image: getImageDeliveryUrl(
        subcategory.image?.url || null,
        IMAGE_DELIVERY_PRESETS.SUBCATEGORY_TILE,
      ),
      parent: subcategory.parent?._id || subcategory.parent || null,
    };
  };

  let data;
  if (includeAllLanguages) {
    data = await fetchSubcategory();
  } else {
    const version = await getCacheVersion(SUBCATEGORY_CACHE_VERSION_KEY);
    data = await getOrSetCache(
      `subcategories:detail:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${id}:${normalizedLang}`,
      SUBCATEGORY_CACHE_TTL_SECONDS,
      fetchSubcategory,
    );
  }

  const userId = user?._id || user?.id || null;
  const isSubscribed = userId || guestId
    ? await isUserSubscribedToSubcategory({
        userId,
        guestId,
        subcategoryId: id,
      })
    : false;
  return { ...data, isSubscribed };
}

export async function createSubcategoryService(payload, file) {
  const { category, parent, name_en, name_ar, desc_en, desc_ar } = payload;

  const categoryExists = await CategoryModel.exists({ _id: category });
  if (!categoryExists) {
    throw new ApiError(`No category found for this id: ${category}`, 400);
  }

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await SubcategoryModel.findOne({
    category,
    slug: normalizedSlug,
  });
  if (existing) {
    throw new ApiError(
      `Subcategory with slug '${normalizedSlug}' already exists for this category`,
      409,
    );
  }

  let image;
  let uploadedImage;

  if (file) {
    validateImageFile(file);
    image = await uploadImage(file, {
      folder: "petyard/subcategories",
      publicId: `subcategory_${normalizedSlug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.TILE,
    });
    uploadedImage = image;
  }

  try {
    const subcategory = await SubcategoryModel.create({
      slug: normalizedSlug,
      category,
      parent: parent || null,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(image && { image }),
    });

    await invalidateSubcategoryCaches();

    return subcategory;
  } catch (err) {
    if (uploadedImage) {
      await deleteImage(uploadedImage);
    }
    throw err;
  }
}

export async function updateSubcategoryService(id, payload, file) {
  const subcategory = await SubcategoryModel.findById(id);
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${id}`, 404);
  }

  const { category, parent, name_en, name_ar, desc_en, desc_ar } = payload;

  if (category !== undefined) {
    const categoryExists = await CategoryModel.exists({ _id: category });
    if (!categoryExists) {
      throw new ApiError(`No category found for this id: ${category}`, 400);
    }
    subcategory.category = category;
  }

  if (parent !== undefined) subcategory.parent = parent || null;

  if (name_en !== undefined) subcategory.name_en = name_en;
  if (name_ar !== undefined) subcategory.name_ar = name_ar;
  if (desc_en !== undefined) subcategory.desc_en = desc_en;
  if (desc_ar !== undefined) subcategory.desc_ar = desc_ar;

  let newImage;
  let oldImage;

  if (file) {
    validateImageFile(file);
    oldImage = subcategory.image
      ? {
          public_id: subcategory.image.public_id,
          url: subcategory.image.url,
        }
      : null;
    newImage = await uploadImage(file, {
      folder: "petyard/subcategories",
      publicId: `subcategory_${subcategory.slug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.TILE,
    });
    subcategory.image = newImage;
  }

  try {
    const updated = await subcategory.save();

    if (oldImage) {
      await deleteImage(oldImage);
    }

    await invalidateSubcategoryCaches();

    return updated;
  } catch (err) {
    if (newImage) {
      await deleteImage(newImage);
    }
    throw err;
  }
}

export async function deleteSubcategoryService(id) {
  const subcategory = await SubcategoryModel.findById(id);
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${id}`, 404);
  }

  if (subcategory.image?.url) {
    await deleteImage(subcategory.image);
  }

  await SubcategoryModel.deleteOne({ _id: id });
  try {
    await cleanupSubscriptionsForSubcategory(id);
  } catch (error) {
    console.error(
      "[Subcategory] Failed to clean subscription records:",
      error?.message || error,
    );
  }
  await invalidateSubcategoryCaches();
}

/**
 * Recursively collects all descendant subcategory IDs for a given parent.
 * Used for inclusive browsing: querying a parent subcategory returns
 * products from that subcategory AND all its nested children.
 */
export async function getSubcategoryChildrenIds(parentId) {
  const version = await getCacheVersion(SUBCATEGORY_CACHE_VERSION_KEY);

  return getOrSetCache(
    `subcategories:children:v1:${version}:${parentId}`,
    SUBCATEGORY_CACHE_TTL_SECONDS,
    async () => {
      const children = await SubcategoryModel.find(
        { parent: parentId },
        { _id: 1 },
      ).lean();

      const ids = children.map((c) => String(c._id));
      const nested = await Promise.all(ids.map(getSubcategoryChildrenIds));

      return ids.concat(nested.flat());
    },
  );
}
