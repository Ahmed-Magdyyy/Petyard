import { createPublicProductVideoRepository } from "./publicProductVideo.repository.js";

function projectMedia(images, rows) {
  const media = images.map((image, position) => ({
    id: `image:${image.public_id}`, type: "image", position,
    public_id: image.public_id, url: image.url, isMain: image.isMain,
  }));
  for (const row of rows) {
    media.push({
      id: String(row._id), type: "video", position: media.length,
      posterUrl: row.asset.poster?.url || null,
      durationSeconds: row.asset.durationSeconds,
      width: row.asset.width, height: row.asset.height,
      aspectRatio: row.asset.width / row.asset.height,
      canSave: false, playbackHref: `/api/v1/product-videos/${row._id}/playback`,
    });
  }
  return media;
}

export function createProductMediaService({ repository = createPublicProductVideoRepository(),
  isEnabled = () => false } = {}) {
  if (typeof repository?.listForProduct !== "function" || typeof isEnabled !== "function") {
    throw new TypeError("Product media dependencies are required");
  }
  return Object.freeze({
    async project({ productId, images = [] }) {
      return projectMedia(images, isEnabled() ? await repository.listForProduct(productId) : []);
    },
    async projectMany(products) {
      const rows = products.length && isEnabled() ?
        await repository.listForProducts(products.map((product) => product.productId)) : [];
      const byProduct = new Map();
      for (const row of rows) {
        const key = String(row.productId);
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(row);
      }
      return new Map(products.map(({ productId, images = [] }) =>
        [String(productId), projectMedia(images, byProduct.get(String(productId)) || [])]));
    },
  });
}

const productionService = createProductMediaService({
  isEnabled: () => String(process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
});

export function projectProductMedia(input) {
  return productionService.project(input);
}

export function projectProductsMedia(input) {
  return productionService.projectMany(input);
}
