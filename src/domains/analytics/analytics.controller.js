import asyncHandler from "express-async-handler";
import {
  getOrdersOverviewService,
  getTopProductsService,
  getServicesOverviewService,
  getStatsService,
  getSalesChartService,
} from "./analytics.service.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the appliedFilters metadata for the response.
 * Lets the frontend know exactly what scope the data covers.
 */
function buildAppliedFilters({ from, to, warehouse, location } = {}) {
  const filters = {
    timeRange:
      from && to
        ? { from, to, type: "custom" }
        : { from: null, to: null, type: "lifetime" },
  };

  if (warehouse !== undefined) filters.warehouse = warehouse || null;
  if (location !== undefined) filters.location = location || null;

  return filters;
}

// ─── 1. Orders Overview ──────────────────────────────────────────────────────

export const getOrdersOverview = asyncHandler(async (req, res) => {
  const { from, to, warehouse } = req.query;

  const data = await getOrdersOverviewService({ from, to, warehouse });

  res.status(200).json({
    appliedFilters: buildAppliedFilters({ from, to, warehouse }),
    data,
  });
});

// ─── 2. Top Products ─────────────────────────────────────────────────────────

export const getTopProducts = asyncHandler(async (req, res) => {
  const { from, to, warehouse, limit } = req.query;

  const data = await getTopProductsService({ from, to, warehouse, limit });

  res.status(200).json({
    appliedFilters: buildAppliedFilters({ from, to, warehouse }),
    data,
  });
});

// ─── 3. Services Overview ────────────────────────────────────────────────────

export const getServicesOverview = asyncHandler(async (req, res) => {
  const { from, to, location } = req.query;

  const data = await getServicesOverviewService({ from, to, location });

  res.status(200).json({
    appliedFilters: buildAppliedFilters({ from, to, location }),
    data,
  });
});

// ─── 4. Stats ────────────────────────────────────────────────────────────────

export const getStats = asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  const data = await getStatsService({ from, to });

  res.status(200).json({
    appliedFilters: buildAppliedFilters({ from, to }),
    data,
  });
});

// ─── 5. Sales Chart ──────────────────────────────────────────────────────────

export const getSalesChart = asyncHandler(async (req, res) => {
  const { from, to, warehouse, location } = req.query;

  const data = await getSalesChartService({ from, to, warehouse, location });

  res.status(200).json({
    appliedFilters: buildAppliedFilters({ from, to, warehouse, location }),
    data,
  });
});
