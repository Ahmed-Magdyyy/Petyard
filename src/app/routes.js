// src/app/routes.js
import authRoutes from "../domains/auth/auth.routes.js";
import userRoutes from "../domains/user/user.routes.js";
import conditionRoutes from "../domains/condition/condition.routes.js";
import petsRoutes from "../domains/pet/pet.routes.js";
import warehouseRoutes from "../domains/warehouse/warehouse.routes.js";
import zoneRoutes from "../domains/zone/zone.routes.js";

export function mountRoutes(app) {
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/conditions", conditionRoutes);
  app.use("/api/v1/pets", petsRoutes);
  app.use("/api/v1/warehouses", warehouseRoutes);
  app.use("/api/v1/zones", zoneRoutes);
}