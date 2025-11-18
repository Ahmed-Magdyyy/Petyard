// src/app/routes.js
import authRoutes from "../domains/auth/auth.routes.js";
import userRoutes from "../domains/user/user.routes.js";


export function mountRoutes(app) {
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/users", userRoutes);

}