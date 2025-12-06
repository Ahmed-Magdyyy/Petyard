// src/app/routes.js
import authRoutes from "../domains/auth/auth.routes.js";
import userRoutes from "../domains/user/user.routes.js";
import conditionRoutes from "../domains/condition/condition.routes.js";
import petsRoutes from "../domains/pet/pet.routes.js";
import warehouseRoutes from "../domains/warehouse/warehouse.routes.js";
import locationRoutes from "../domains/location/location.routes.js";
import categoryRoutes from "../domains/category/category.routes.js";
import subcategoryRoutes from "../domains/subcategory/subcategory.routes.js";
import brandRoutes from "../domains/brand/brand.routes.js";
import productRoutes from "../domains/product/product.routes.js";
import cartRoutes from "../domains/cart/cart.routes.js";
import couponRoutes from "../domains/coupon/coupon.routes.js";
import checkoutRoutes from "../domains/checkout/checkout.routes.js";
import orderRoutes from "../domains/order/order.routes.js";

export function mountRoutes(app) {
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/conditions", conditionRoutes);
  app.use("/api/v1/pets", petsRoutes);
  app.use("/api/v1/warehouses", warehouseRoutes);
  app.use("/api/v1/locations", locationRoutes);
  app.use("/api/v1/categories", categoryRoutes);
  app.use("/api/v1/subcategories", subcategoryRoutes);
  app.use("/api/v1/brands", brandRoutes);
  app.use("/api/v1/products", productRoutes);
  app.use("/api/v1/cart", cartRoutes);
  app.use("/api/v1/coupons", couponRoutes);
  app.use("/api/v1/checkout", checkoutRoutes);
  app.use("/api/v1/orders", orderRoutes);
}