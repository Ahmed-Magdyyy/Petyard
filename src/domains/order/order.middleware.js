import asyncHandler from "express-async-handler";
import { roles } from "../../shared/constants/enums.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";

export const scopeOrdersToModeratorWarehouses = asyncHandler(
  async (req, res, next) => {
    if (!req.user || req.user.role !== roles.MODERATOR) {
      req.orderWarehouseScope = null;
      return next();
    }

    const warehouses = await WarehouseModel.find({ moderators: req.user._id })
      .select("_id")
      .lean();

    req.orderWarehouseScope = warehouses.map((w) => w._id);
    next();
  }
);
